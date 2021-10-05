import { DatabaseAdapter, DbConfig, DbMemRecord, DbRecord, DbRecordRef, IdParam, IHttp, ObjEventType, ObjListener } from "./db-types";
import React from "react";
import { ResultSet, ResultSetError, SQLError, SQLResultSet, SQLTransaction, WebSQLDatabase } from "./sqlite-types";

const dbSchemaVersion='3';
const dbDataStructure='3';

const toKey=(collection:string,id:string|number)=>collection+':'+id;

const defaultConfig:Required<DbConfig>={
    databaseName:'client-db.db',
    crudPrefix:'',
    primaryKey:'Id',
    getPrimaryKey:null,
    primaryKeyMap:null,
    endPointMap:{},
    collectionRelations:[],
    defaultTTLMinutes:60*24//one day
}

interface LoadedRef{
    collection:string;
    refCollection:string|null;
    id:string;
    isCollection:boolean;
}


export default class ClientDb
{
    private readonly http:IHttp;

    private readonly memCache:{[key:string]:DbMemRecord}={}

    private loadedRefs:{[key:string]:LoadedRef}={}

    private readonly writeLock:Lock=new Lock(1);

    private readonly listeners:ObjListener[]=[];

    private readonly config:Required<DbConfig>;

    private readonly openDatabase:DatabaseAdapter;

    private __db:WebSQLDatabase|null=null;
    private get db():WebSQLDatabase{
        if(!this.__db){
            throw new Error('ClientDb not initialized')
        }
        return this.__db;
    }



    public constructor(http:IHttp,config:DbConfig|null,openDatabase:DatabaseAdapter)
    {
        this.http=http;
        this.config={...defaultConfig,...(config||{})};
        this.openDatabase=openDatabase;
    }

    public async initAsync()
    {
        this.__db=this.openDatabase(this.config);

        await this.execAsync(`
            CREATE TABLE IF NOT EXISTS "settings"(
                "name" VARCHAR(50) NOT NULL,
                "value" TEXT NOT NULL
            )
        `);

        const committed=await this.getSettingAsync('settingsCommitted');
        if(committed!=='1'){
            await this.execAsync('DELETE FROM "settings"');
        }

        const sv=await this.getSettingAsync('dbSchemaVersion');
        if(sv!==dbSchemaVersion){
            console.log(`Updating ClientDb dbSchemaVersion. ${sv||'(none)'} -> ${dbSchemaVersion}`)
            await this.execAsync('DROP TABLE IF EXISTS "objs"');
        }

        await this.execAsync([`
            CREATE TABLE IF NOT EXISTS "objs"(
                "expires" INTEGER NOT NULL,
                "collection" VARCHAR(150) NOT NULL,
                "refCollection" VARCHAR(100) NULL,
                "objId" INTEGER NOT NULL,
                "obj" TEXT
            )
        `,
        `
            CREATE UNIQUE INDEX IF NOT EXISTS "objsIndex" ON "objs" ( "objId", "collection")
        `]);

        const ds=await this.getSettingAsync('dbDataStructure');
        if(ds!==dbDataStructure){
            console.log(`Updating ClientDb dbDataStructure. ${ds||'(none)'} -> ${dbDataStructure}`)
            await this.execAsync('DELETE FROM "objs"');
            await this.nonTransactionalExecAsync('VACUUM');

        }

        // Commit settings
        if(sv!==dbSchemaVersion || ds!==dbDataStructure){
            await this.setSettingAsync('settingsCommitted','0');
            await this.setSettingAsync('dbSchemaVersion',dbSchemaVersion);
            await this.setSettingAsync('dbDataStructure',dbDataStructure);
            await this.setSettingAsync('settingsCommitted','1');
        }
    }

    public getConfig():Required<DbConfig>
    {
        return {...this.config}
    }

    private getExpires(ttl?:number)
    {
        if(ttl===undefined){
            ttl=this.config.defaultTTLMinutes*60*1000;
        }
        return new Date().getTime()+ttl;
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

    private callListeners(type:ObjEventType,collection:string,id:string,obj:any,includeRef:boolean){
        for(const l of this.listeners){
            l(type,collection,id,obj,includeRef);
        }
        if(type==='reset' || type==='update' || type==='delete' || type==='resetCollection'){
            for(const r of this.config.collectionRelations){
                if(r.depCollection===collection){
                    if(r.resetAll){
                        this.removeAllRecordsNextFrame(r.collection);
                    }
                }
            }
        }
    }

    private async getSettingAsync(name:string):Promise<string|null>
    {
        if(!name){
            return null;
        }
        const r=await this.selectAsync(
            'SELECT "value" from "settings" where "name" = ? LIMIT 1',
            [name]);

        return r.rows?.item(0)?.value||null;
    }

    private async setSettingAsync(name:string, value:string)
    {
        if(!name){
            return;
        }

         const r=await this.selectAsync(
            'SELECT "value" from "settings" where "name" = ? LIMIT 1',
            [name]);

        if(r.rows?.length){
            await this.execAsync(
                'UPDATE "settings" SET "value" = ? WHERE "name" = ?',
                [value,name]);
        }else{
            await this.execAsync(
                'INSERT INTO "settings" ("name","value") VALUES (?,?)',
                [name,value]);
        }
    }

    public getPrimaryKey(collection:string,obj:any):string
    {
        if(!obj){
            return '';
        }
        let key:string|null|undefined;
        if(this.config.getPrimaryKey){
            key=this.config.getPrimaryKey(collection,obj);
            if(key!==null && key!==undefined){
                return key;
            }
        }
        const mapped=this.config.primaryKeyMap?.[collection];
        key=obj[mapped||this.config.primaryKey];
        if(key===null || key===undefined){
            return '';
        }
        return key+'';
    }


    private async nonTransactionalExecAsync(sql:string,args?:any[],readOnly:boolean=false):Promise<(ResultSetError|ResultSet)[]|undefined>
    {
        const db=this.db;
        if(!db.exec){
            return;
        }
        return await new Promise<(ResultSetError|ResultSet)[]|undefined>((success,error)=>{
            if(!db.exec){
                error('exec not implemented');
                return;
            }
            db.exec([{sql,args:args||[]}],readOnly,(err,r)=>{
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
                console.log('execAsync error',exec,args)
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

    private async setRecordsAsync(evtType:'set'|'update', records:DbMemRecord[]):Promise<void>
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
                        'UPDATE "objs" SET "expires" = ?, "obj" = ? WHERE "objId" = ? AND "collection" = ?',
                        [record.expires,JSON.stringify(record.obj),record.objId,record.collection]
                    )
                }else{
                    await this.execAsync(
                        'INSERT INTO "objs" ("expires","collection","refCollection","objId","obj") VALUES (?,?,?,?,?)',
                        [record.expires,record.collection,record.refCollection||'',record.objId,JSON.stringify(record.obj)]
                    )
                }
            }


        }finally{
            release();
        }
        for(const record of records){
            this.callListeners(evtType,record.collection,record.objId,record.obj,false);
        }
    }

    private async removeRecordAsync(collection:string,id:IdParam,includeRefs:boolean,type:ObjEventType,defaultObj?:any):Promise<void>
    {

        if(id===undefined || id===null){
            return;
        }

        let obj:any=defaultObj;

        const release=await this.writeLock.waitAsync();
        try{

            if(includeRefs){
                await this.execAsync(
                    'DELETE FROM "objs" WHERE "objId" = ? AND ( "collection" = ? OR "refCollection" = ? )',
                    [id.toString(),collection,collection]
                )
            }else{
                await this.execAsync(
                    'DELETE FROM "objs" WHERE "objId" = ? AND "collection" = ?',
                    [id.toString(),collection]
                )
            }

            if(!obj){
                const cached=await this.findLocalRecordAsync(collection,id);
                obj=cached?.obj;
            }
            delete this.memCache[toKey(collection,id)];

            if(includeRefs){
                const strId=id.toString();
                for(const e in this.memCache){
                    const r=this.memCache[e];
                    if(r.refCollection===collection && r.objId===strId){
                        delete this.memCache[e];
                    }
                }

                for(const e in this.loadedRefs){
                    const ld=this.loadedRefs[e];
                    if(ld.isCollection && ld.refCollection===collection && ld.id===strId){
                        delete this.loadedRefs[e];
                    }
                }
            }

        }finally{
            release();
        }
        this.callListeners(type,collection,id.toString(),obj,includeRefs);
    }

    private async removeAllRecordsNextFrame(collection:string)
    {
        setTimeout(()=>{
            this.removeAllRecordsAsync(collection);
        },1)
    }

    private async removeAllRecordsAsync(collection:string):Promise<void>
    {

        const release=await this.writeLock.waitAsync();
        try{
            await this.execAsync(
                'DELETE FROM "objs" WHERE "collection" = ? OR "refCollection" = ?',
                [collection,collection]
            )

            for(const e in this.memCache){
                const record=this.memCache[e];
                if(record.collection===collection || record.refCollection===collection){
                    delete this.memCache[e];
                }
            }

        }finally{
            release();
        }
        this.callListeners('resetCollection',collection,'(all)',undefined,false);
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

        this.callListeners(eventType,'','',undefined,false);
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
            refCollection:row.refCollection||null,
            objId:row.objId,
            obj:JSON.parse(row.obj)
        }

        this.memCache[key]=record;
        return record;

    }

    public async setAsync(collection:string,obj:any):Promise<void>
    {
        await this.setRecordsAsync('set',[{
            expires:this.getExpires(),
            collection,
            refCollection:null,
            objId:this.getPrimaryKey(collection,obj),
            obj:obj||null
        }])
    }

    public newAsync(collection:string,obj:any):Promise<void>
    {
        if(typeof obj !== 'object'){
            throw new Error('newAsync obj param must be an object')
        }
        return this.removeRecordAsync(collection,this.getPrimaryKey(collection,obj),false,'reset',obj);
    }

    public updateAsync(collection:string,id:IdParam,includeRefs:boolean=false):Promise<void>
    {
        return this.removeRecordAsync(collection,id,includeRefs,'reset');
    }

    public async updateInPlaceAsync<T>(collection:string,id:IdParam,update:(obj:T,collection:string,id:IdParam)=>T|null):Promise<T|null>
    {

        const cached=await this.findLocalRecordAsync(collection,id);
        if(!cached || isExpired(cached)){
            return null;
        }

        const obj=update(cached.obj,collection,id);
        if(obj===null){
            return null;
        }
        if(obj===cached.obj){
            throw new Error(
                'updateInPlaceAsync updated should return a new copy of the target object. '+
                'Collection:'+collection+', id:'+id);
        }

        await this.setRecordsAsync('update',[{
            expires:cached.expires,
            collection,
            refCollection:cached.refCollection,
            objId:this.getPrimaryKey(collection,obj),
            obj:obj
        }]);

        return obj;
    }

    public deleteAsync(collection:string,id:IdParam):Promise<void>
    {
        return this.removeRecordAsync(collection,id,false,'delete');
    }

    private getEndPoint(collection:string,id:IdParam,property?:string)
    {
        const custom=this.config.endPointMap[collection];
        const customStr=typeof custom === 'function'?custom(collection,id):custom;
        return (customStr||this.config.crudPrefix+collection+(id===undefined || id===null?'':'/'+id))+
            (property?'/'+property:'');
    }

    public getObjAsync<T>(collection:string,id:IdParam,endpoint?:string):Promise<T|null>
    {
        return this.syncAsync<T|null>(['getObjAsync',collection,id],async ()=>{
            if(id===null || id===undefined){
                return null;
            }

            const cached=await this.findLocalRecordAsync(collection,id);
            if(cached && !isExpired(cached)){
                return cached.obj;
            }

            const obj=await this.http.getAsync<T>(endpoint||this.getEndPoint(collection,id));

            await this.setRecordsAsync('set',[{
                expires:this.getExpires(),
                collection,
                refCollection:null,
                objId:id.toString(),
                obj:obj||null
            }])

            return obj||null;
        });
    }

    public async getMappedObj<T>(
        endpoint:string,
        isCollection:boolean,
        cacheKey:string,
        cacheId:number,
        collection:string,
        noCache:boolean=false):Promise<T|null>
    {

        const cached=noCache?undefined:await this.findLocalRecordAsync(cacheKey,cacheId);
        if(cached && !isExpired(cached)){

            if(isCollection){
                const col=await this.findLocalCollectionAsync(cacheKey,collection,cacheId.toString(),cached.obj);
                if(col){
                    return col as any;
                }
            }else{
                const firstId=(cached.obj as DbRecordRef)?.ids?.[0];
                if(firstId){
                    const rObj=await this.findLocalRecordAsync(collection,firstId);
                    if(rObj){
                        return rObj.obj
                    }
                }
            }
            await this.deleteAsync(cacheKey,cacheId);
        }

        const obj=await this.http.getAsync<T>(endpoint);

        const ids:string[]=[];
        const records:DbMemRecord[]=[];

        if(isCollection){
            const ary=obj as any as any[];
            for(const o of ary){
                const id=this.getPrimaryKey(collection,o);
                records.push({
                    expires:this.getExpires(),
                    collection:collection,
                    refCollection:null,
                    objId:id,
                    obj:o||null
                });
                ids.push(id);
            }
        }else{
            const id=this.getPrimaryKey(collection,obj);
            records.push({
                expires:this.getExpires(),
                collection:collection,
                refCollection:null,
                objId:id,
                obj:obj||null
            })
            ids.push(id);
        }
            await this.setRecordsAsync('set',records);

        const idRef:DbRecordRef={
            ids
        }
        records.push({
            expires:this.getExpires(),
            collection:cacheKey,
            refCollection:collection,
            objId:cacheId.toString(),
            obj:idRef
        });

        await this.setRecordsAsync('set',records);


        return obj||null;
    }

    public getObjRefCollection<T,TRef>(
        collection:string,
        id:IdParam,
        refCollection:string,
        property:keyof(T)|string,
        foreignKey:keyof(TRef),
        clearCache?:boolean,
        endpoint?:string)
        :Promise<TRef[]|null>
    {
        return this.getObjRef<T,TRef>(
            collection,
            id,
            refCollection,
            property as string,
            foreignKey as string,
            true,
            clearCache,
            endpoint) as Promise<TRef[]|null>;

    }

    public getObjRefSingle<T,TRef>(
        collection:string,
        id:IdParam,
        refCollection:string,
        property:keyof(T)|null,
        foreignKey:keyof(T),
        endpoint?:string)
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

        return this.getObjRef<T,TRef>(
            collection,
            id,
            refCollection,
            property as string,
            foreignKey as string,
            false,
            undefined,
            endpoint) as Promise<TRef|null>;
    }

    private async getObjRef<T,TRef>(
        collection:string,
        id:IdParam,
        refCollection:string,
        property:string,
        foreignKey:string,
        isCollection:boolean,
        clearCache?:boolean,
        endpoint?:string)
        :Promise<TRef|TRef[]|null>
    {
        return this.syncAsync<TRef|TRef[]|null>(
        ['getObjRef',collection,id,refCollection,property,foreignKey,isCollection],
        async ()=>{

            if(id===null || id===undefined){
                return null;
            }

            const refFlag=`${collection}:REF:${property}`;

            const cached=clearCache?null:await this.findLocalRecordAsync(refFlag,id);
            if(cached && !isExpired(cached)){
                const val=
                    isCollection?
                    await this.findLocalRefCollectionAsync(refCollection,collection,foreignKey as string,id,cached.obj):
                    await this.findLocalRefSingleAsync(collection,refCollection,foreignKey as string,id,cached.obj);
                if(val){
                    return val;
                }
                // if no ary the items do not match and need refreshed
                await this.deleteAsync(refFlag,id);
            }

            const objResult=await this.http.getAsync<TRef[]|TRef>(endpoint||this.getEndPoint(collection,id,property));

            if(!objResult){
                return null;
            }

            const isAry=Array.isArray(objResult);
            if(isAry && !isCollection){
                throw new Error('Mismatch isCollection');
            }

            const records:DbMemRecord[]=isAry?
                (objResult as TRef[]).map<DbMemRecord>(obj=>({
                    expires:this.getExpires(),
                    collection:refCollection,
                    refCollection:null,
                    objId:this.getPrimaryKey(refCollection,obj),
                    obj:obj||null
                }))
            :
                [{
                    expires:this.getExpires(),
                    collection:refCollection,
                    refCollection:null,
                    objId:this.getPrimaryKey(refCollection,objResult),
                    obj:objResult||null
                }]

            const collectionRef:DbRecordRef={
                ids:isAry?(objResult as TRef[]).map(o=>this.getPrimaryKey(refCollection,o)):undefined,
                id:!isAry?this.getPrimaryKey(refCollection,objResult):undefined
            }

            records.push({
                expires:this.getExpires(),
                collection:refFlag,
                refCollection:collection,
                objId:id.toString(),
                obj:collectionRef
            });

            await this.setRecordsAsync('set',records)

            return objResult||null;
        });
    }


    private readonly syncMap:{[key:string]:Promise<any>}={}
    private async syncAsync<T>(deps:any[],getAsync:()=>Promise<T>):Promise<T>
    {
        let key='';
        for(const k of deps){
            key+='::'+k;
        }
        let p=this.syncMap[key];
        if(p as any){
            return await p;
        }

        try{
            p=getAsync();
            this.syncMap[key]=p;
            return await p;
        }finally{

            delete this.syncMap[key];

        }
    }

    private async findLocalCollectionAsync(
        collection:string,sourceCollection:string,id:string,recordRef:DbRecordRef):Promise<any[]|null>
    {

        if(!id){
            return null;
        }

        if(!recordRef.ids){
            throw new Error('recordRef.ids required');
        }

        const refKey=toKey(collection,id);

        const map:{[key:string]:any}={};
        const ids:string[]=[...recordRef.ids];
        let count=0;
        for(const e in this.memCache){
            const r=this.memCache[e];
            if(r.collection===sourceCollection && recordRef.ids.includes(r.objId)){
                if(map[r.objId]){
                    throw new Error('Duplicate mem cached key found. record.objId='+r.objId);
                }
                map[r.objId]=r.obj;
                const x=ids.indexOf(r.objId);
                if(x>-1){
                    ids.splice(x,1);
                }
                count++;
            }
        }

        if(ids.length){

            const r=await this.selectAsync(
                'SELECT * FROM "objs" WHERE "collection" = ? AND "objId" IN ('+ids.join(',')+')',
                [sourceCollection]
            )

            if(r.rows?.length){
                const records:DbMemRecord[]=[];
                for(let i=0;i<r.rows.length;i++){
                    const item=r.rows.item(i) as DbRecord;
                    const record={
                        expires:item.expires,
                        collection:item.collection,
                        refCollection:null,
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
                await this.setRecordsAsync('set',records);
            }
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

    private async findLocalRefCollectionAsync(
        collection:string,refCollection:string,foreignKey:string,id:IdParam,recordRef:DbRecordRef):Promise<any[]|null>
    {

        if(id===null || id===undefined){
            return null;
        }

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
                            refCollection:null,
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
                    await this.setRecordsAsync('set',records);
                }
            }

            this.loadedRefs[refKey]={
                collection,
                refCollection,
                id:id?.toString(),
                isCollection:true

            };
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
