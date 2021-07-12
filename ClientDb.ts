import { DbConfig, DbMemRecord, DbRecord, DbRecordRef, IdParam, IHttp, ObjEventType, ObjListener } from "./db-types";
import * as SQLite from 'expo-sqlite';
import { ResultSet, ResultSetError, SQLError, SQLResultSet, SQLTransaction, WebSQLDatabase } from "expo-sqlite";
import React from "react";
import { FileSystem } from "react-native-unimodules";

const toKey=(collection:string,id:string|number)=>collection+':'+id;

const defaultConfig:Required<DbConfig>={
    databaseName:'client-db.db',
    crudPrefix:'',
    primaryKey:'Id',
    getPrimaryKey:null
}


export default class ClientDb
{
    private readonly http:IHttp;

    private readonly memCache:{[key:string]:DbMemRecord}={}

    private loadedRefs:{[key:string]:boolean}={}

    private readonly writeLock:Lock=new Lock(1);

    private readonly listeners:ObjListener[]=[];

    private readonly config:Required<DbConfig>;

    private __db:WebSQLDatabase|null=null;
    private get db():WebSQLDatabase{
        if(!this.__db){
            throw new Error('ClientDb not initialized')
        }
        return this.__db;
    }



    public constructor(http:IHttp,config?:DbConfig)
    {
        this.http=http;
        this.config={...defaultConfig,...config};
    }

    public async initAsync()
    {
        this.__db=SQLite.openDatabase(this.config.databaseName);
        await this.execAsync([`
            CREATE TABLE IF NOT EXISTS "objs"(
                "expires" INTEGER NOT NULL,
                "collection" VARCHAR(100) NOT NULL,
                "objId" INTEGER NOT NULL,
                "obj" TEXT
            )
        `,
        `
            CREATE UNIQUE INDEX IF NOT EXISTS "objsIndex" ON "objs" ( "objId", "collection")
        `]);
    }

    public addListener(listener:ObjListener)
    {
        this.listeners.push(listener);
    }

    public removeListener(listener:ObjListener)
    {
        const index=this.listeners.indexOf(listener);
        if(index!==-1){
            this.listeners.splice(index,1);
        }
    }

    private callListeners(type:ObjEventType,collection:string,id:string,obj:any){
        for(const l of this.listeners){
            l(type,collection,id,obj);
        }
    }

    public getPrimaryKey(collection:string,obj:any):string
    {
        if(!obj){
            return '';
        }
        const key=obj[this.config.getPrimaryKey?this.config.getPrimaryKey(collection):this.config.primaryKey];
        if(key===null || key===undefined){
            return '';
        }
        return key+'';
    }


    private nonTransactionalExecAsync(sql:string,args?:any[],readOnly:boolean=false):Promise<(ResultSetError|ResultSet)[]|undefined>
    {
        return new Promise<(ResultSetError|ResultSet)[]|undefined>((success,error)=>{
            this.db.exec([{sql,args:args||[]}],readOnly,(err,r)=>{
                if(err){
                    error(err);
                }else{
                    success(r);
                }
            });
        });
    }

    private execAsync(exec:((tx:SQLTransaction)=>void)|string|string[],args?:any[]|any[][]):Promise<void>
    {

        return new Promise<void>((success,error)=>{
            this.db.transaction(tx=>{
                if(typeof(exec) === 'string'){
                    tx.executeSql(exec,args);
                }else if(Array.isArray(exec)){
                    for(let i=0;i<exec.length;i++){
                        const sql=exec[i];
                        if(!sql){
                            continue;
                        }
                        tx.executeSql(sql),args?.[i];
                    }
                }else{
                    exec(tx);
                }
            },
            (err:SQLError)=>{
                error(err.message+' - code:'+err.code);
            },
            success)

        });
    }

    private selectAsync(sql:string,args?:any[]):Promise<SQLResultSet>
    {
        return new Promise<SQLResultSet>((success,error)=>{
            this.db.transaction(tx=>{
                tx.executeSql(sql,args,
                    (_t,result)=>{
                        success(result);
                    },
                    (_t,err)=>{
                        error(err.message+' - code:'+err.code);
                        return true;
                    });
            },
            (err:SQLError)=>{
                error(err.message+' - code:'+err.code)
            })
        });
    }

    private async setRecordsAsync(records:DbMemRecord[]):Promise<void>
    {

        const release=await this.writeLock.waitAsync();
        try{

            for(const record of records){

                this.memCache[toKey(record.collection,record.objId)]=record;

                const c=await this.selectAsync(
                    'SELECT COUNT(*) as "count" FROM "objs" where "objId" = ? AND "collection" = ? LIMIT 1',
                    [record.objId,record.collection]
                )

                if(c.rows?.item(0)?.count){
                    await this.execAsync(
                        'UPDATE "objs" SET "expires" = ?, "obj" = ? WHERE "objId" = ? AND "collection" = ? LIMIT 1',
                        [record.expires,JSON.stringify(record.obj),record.objId,record.collection]
                    )
                }else{
                    await this.execAsync(
                        'INSERT INTO "objs" ("expires","collection","objId","obj") VALUES (?,?,?,?)',
                        [record.expires,record.collection,record.objId,JSON.stringify(record.obj)]
                    )
                }
            }


        }finally{
            release();
        }
        for(const record of records){
            this.callListeners('set',record.collection,record.objId,record.obj);
        }
    }

    private async removeRecordAsync(collection:string,id:IdParam,type:ObjEventType):Promise<void>
    {

        if(id===undefined || id===null){
            return;
        }

        const release=await this.writeLock.waitAsync();
        try{

            await this.execAsync(
                'DELETE FROM "objs" WHERE "objId" = ? AND "collection" = ? LIMIT 1',
                [id.toString(),collection]
            )

            delete this.memCache[toKey(collection,id)];

        }finally{
            release();
        }
        this.callListeners(type,collection,id.toString(),undefined);
    }

    public resetAllAsync():Promise<void>
    {
        return this.clearDbAsync('resetAll');
    }

    public clearAllAsync():Promise<void>
    {
        return this.clearDbAsync('clearAll');
    }

    private async clearDbAsync(eventType:ObjEventType):Promise<void>
    {
        const release=await this.writeLock.waitAsync();
        try{

            await this.execAsync('DELETE FROM "objs"');

            await this.nonTransactionalExecAsync('VACUUM');

            this.loadedRefs={};

            for(const e in this.memCache){
                delete this.memCache[e];
            }

        }finally{
            release();
        }

        this.callListeners(eventType,'','',undefined);
    }

    private async findLocalRecordAsync(collection:string, id:IdParam):Promise<DbMemRecord|undefined>
    {
        if(id===null || id===undefined){
            return undefined;
        }

        const key=toKey(collection,id);
        const m=this.memCache[key];
        if(m){
            return m;
        }

        const r=await this.selectAsync(
            'SELECT * FROM "objs" where "objId" = ? AND "collection" = ? LIMIT 1',
        [id.toString(),collection]);

        if(!r.rows?.length){
            return undefined;
        }

        const row:DbRecord=r.rows.item(0);
        if(!row){
            return undefined;
        }

        const record:DbMemRecord={
            expires:row.expires,
            collection:row.collection,
            objId:row.objId,
            obj:JSON.parse(row.obj)
        }

        this.memCache[key]=record;
        return record;

    }

    public resetAsync(collection:string,id:IdParam):Promise<void>
    {
        return this.removeRecordAsync(collection,id,'reset');
    }

    public deleteAsync(collection:string,id:IdParam):Promise<void>
    {
        return this.removeRecordAsync(collection,id,'delete');
    }

    public async getObjAsync<T>(collection:string,id:IdParam):Promise<T|null>
    {
        if(id===null || id===undefined){
            return null;
        }

        const cached=await this.findLocalRecordAsync(collection,id);
        if(cached && !isExpired(cached)){
            return cached.obj;
        }

        const obj=await this.http.getAsync<T>(this.config.crudPrefix+collection+'/'+id);

        await this.setRecordsAsync([{
            expires:0,
            collection,
            objId:id.toString(),
            obj:obj||null
        }])

        return obj||null;
    }

    public getObjRefCollection<T,TRef>(
        collection:string,id:IdParam,refCollection:string,property:keyof(T)|string,foreignKey:keyof(TRef))
        :Promise<TRef[]|null>
    {
        return this.getObjRef<T,TRef>(collection,id,refCollection,property as string,foreignKey as string,true) as Promise<TRef[]|null>;

    }

    public getObjRefSingle<T,TRef>(
        collection:string,id:IdParam,refCollection:string,property:keyof(T)|null,foreignKey:keyof(T))
        :Promise<TRef|null>
    {

        if(!property){
            const fk=foreignKey as string;
            if(fk.endsWith('Id')){
                property=fk.substr(0,fk.length-2) as any;
            }else{
                throw new Error(`Unable to determine the property of collection ${collection} based on foreignKey ${foreignKey}`);
            }
        }

        return this.getObjRef<T,TRef>(collection,id,refCollection,property as string,foreignKey as string,false) as Promise<TRef|null>;
    }

    private async getObjRef<T,TRef>(
        collection:string,
        id:IdParam,
        refCollection:string,
        property:string,
        foreignKey:string,
        isCollection:boolean)
        :Promise<TRef|TRef[]|null>
    {
        if(id===null || id===undefined){
            return null;
        }

        const refFlag=`${collection}:REF:${property}`;

        const cached=await this.findLocalRecordAsync(refFlag,id);
        if(cached && !isExpired(cached)){
            const val=
                isCollection?
                await this.findLocalRefCollectionAsync(refCollection,foreignKey as string,id,cached.obj):
                await this.findLocalRefSingleAsync(collection,refCollection,foreignKey as string,id,cached.obj);
            if(val){
                return val;
            }
            // if no ary the items do not match and need refreshed
            await this.deleteAsync(refFlag,id);
        }

        const objResult=await this.http.getAsync<TRef[]|TRef>(this.config.crudPrefix+collection+'/'+id+'/'+property);

        if(!objResult){
            return null;
        }

        const isAry=Array.isArray(objResult);
        if(isAry && !isCollection){
            throw new Error('Mismatch isCollection');
        }

        const records:DbMemRecord[]=isAry?
            (objResult as TRef[]).map<DbMemRecord>(obj=>({
                expires:0,
                collection:refCollection,
                objId:this.getPrimaryKey(refCollection,obj),
                obj:obj||null
            }))
        :
            [{
                expires:0,
                collection:refCollection,
                objId:this.getPrimaryKey(refCollection,objResult),
                obj:objResult||null
            }]

        const collectionRef:DbRecordRef={
            ids:isAry?(objResult as TRef[]).map(o=>this.getPrimaryKey(refCollection,o)):undefined,
            id:!isAry?this.getPrimaryKey(refCollection,objResult):undefined
        }

        records.push({
            expires:0,
            collection:refFlag,
            objId:id.toString(),
            obj:collectionRef
        });

        await this.setRecordsAsync(records)

        return objResult||null;

    }

    private async findLocalRefCollectionAsync(
        collection:string,foreignKey:string,id:IdParam,recordRef:DbRecordRef):Promise<any[]|null>
    {

        if(!recordRef.ids){
            throw new Error('recordRef.ids required');
        }

        const refKey=collection+':'+foreignKey+':'+id;
        const loaded=this.loadedRefs[refKey];

        const map:{[key:string]:any}={};
        const ids:string[]=[];
        let count=0;
        for(const e in this.memCache){
            const r=this.memCache[e];
            if(r.collection===collection && r.obj?.[foreignKey]===id){
                if(map[r.objId]){
                    throw new Error('Duplicate mem cached key found. record.objId='+r.objId);
                }
                map[r.objId]=r.obj;
                if(!loaded){
                    ids.push(r.objId);
                }
                count++;
            }
        }

        if(!loaded){

            if(count!==recordRef.ids.length){

                const r=await this.selectAsync(
                    'SELECT * FROM "objs" WHERE "collection" = ?'+
                    (ids.length?' AND "objId" NOT IN ('+ids.join(',')+')':'')+
                    ` AND json_extract("obj",'$.${foreignKey}') = ?`,
                    [collection,id]
                )

                if(r.rows?.length){
                    const records:DbMemRecord[]=[];
                    for(let i=0;i<r.rows.length;i++){
                        const item=r.rows.item(i) as DbRecord;
                        const record={
                            expires:item.expires,
                            collection:item.collection,
                            objId:item.objId,
                            obj:JSON.parse(item.obj)
                        }
                        records.push(record);
                        if(map[record.objId]){
                            throw new Error('Duplicate sql db key found. record.objId='+record.objId);
                        }
                        map[item.objId]=record.obj;
                        count++;
                    }
                    await this.setRecordsAsync(records);
                }
            }

            this.loadedRefs[refKey]=true;
        }

        if(count!==recordRef.ids.length){
            // refresh data source needed
            delete this.loadedRefs[refKey];
            return null;
        }

        const objs:any[]=[];
        for(const id of recordRef.ids){
            const obj=map[id];
            if(!obj){
                // refresh data source needed
                return null;
            }
            objs.push(obj);
        }

        return objs;
    }

    private async findLocalRefSingleAsync(
        collection:string,refCollection:string,foreignKey:string,id:IdParam,recordRef:DbRecordRef):Promise<any|null>
    {

        if(!recordRef.id){
            throw new Error('recordRef.id required');
        }

        const parent=await this.findLocalRecordAsync(collection,id);
        if(!parent || !parent.obj){
            return null;
        }

        const fKey=parent.obj[foreignKey];
        const fType=typeof fKey;
        if(fType!=='string' && fType!=='number'){
            return null;
        }

        const child=await this.findLocalRecordAsync(refCollection,fKey);
        return child?.obj||null;
    }

    public getDbFilePath()
    {
        return `${FileSystem.documentDirectory}/SQLite/${this.config.databaseName}`;
    }

}

const isExpired=(r:DbMemRecord):boolean=>r.expires>0 && r.expires<new Date().getTime();

export const ClientDbContext=React.createContext<ClientDb|null>(null);


class Lock
{

    private _count=0;
    private _queue:(()=>void)[]=[];

    private _maxConcurrent:number;

    constructor(maxConcurrent:number=1)
    {
        this._maxConcurrent=maxConcurrent;
    }

    public waitAsync():Promise<()=>void>
    {
        let released=false;
        const release=()=>{
            if(released){
                return;
            }
            released=true;
            this.release();
        }
        if(this._count<this._maxConcurrent){
            this._count++;
            return new Promise(r=>r(release));
        }else{
            return new Promise(r=>{
                this._queue.push(()=>{
                    this._count++;
                    r(release);
                });
            })
        }
    }

    private release()
    {
        this._count--;
        if(this._count<0){
            throw new Error('Lock out of sync. release has be called too many times.')
        }
        if(this._count<this._maxConcurrent && this._queue.length){
            const next=this._queue[0];
            this._queue.shift();
            next();
        }
    }
}