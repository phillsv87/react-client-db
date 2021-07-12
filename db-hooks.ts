import { useContext, useEffect, useState } from "react";
import ClientDb, { ClientDbContext } from "./ClientDb";
import { IdParam, ObjEventType } from "./db-types";

export function useClientDb():ClientDb
{
    const db=useContext(ClientDbContext);
    if(!db){
        throw new Error('useClientDb used outside of ClientDbContext');
    }
    return db;
}

/**
 * Returns an object by id. Undefined is returned while the object is being loaded.
 * Null is returned if the object can not be found by any data providers
 */
export function useObj<T>(collection:string,id:IdParam):T|null|undefined
{
    const db=useClientDb();

    const [obj,setObj]=useState<T|null|undefined>(undefined);

    useEffect(()=>{
        let m=true;
        setObj(undefined);
        const get=async ()=>{
            const obj=await db.getObjAsync<T>(collection,id);
            if(m){
                setObj(obj);
            }
        };
        get();

        const strId=id?.toString();
        const listener=(type:ObjEventType,eCollection:string,eId:string,obj:any)=>{
            if(!m){
                return;
            }
            if(type==='clearAll'){
                setObj(undefined);
            }else if(type==='resetAll'){
                setObj(undefined);
                get();
            }else if(eCollection===collection && eId===strId){
                if(type==='set'){
                    setObj(obj);
                }else if(type==='reset'){
                    setObj(undefined);
                    get();
                }else if(type==='delete'){
                    setObj(undefined);
                }
            }
        }

        db.addListener(listener);


        return ()=>{
            m=false;
            db.removeListener(listener);
        }
    },[collection,id,db]);

    return obj;
}

export function useObjCollectionRef<T,TRef>(
    collection:string,
    id:IdParam,
    refCollection:string,
    property:keyof(T)|string,
    foreignKey:keyof(TRef))
    :TRef[]|null|undefined
{
    const db=useClientDb();

    const [obj,setObj]=useState<TRef[]|null|undefined>(undefined);

    useEffect(()=>{
        let m=true;
        setObj(undefined);
        let objs:TRef[]|null=null;
        let ids:string[]|null=null;
        const get=async ()=>{
            objs=await db.getObjRefCollection<T,TRef>(collection,id,refCollection,property,foreignKey);
            ids=objs?.map(o=>db.getPrimaryKey(refCollection,o))||null;
            if(m){
                setObj(objs);
            }
        };
        get();

        const strId=id?.toString();
        const listener=(type:ObjEventType,eCollection:string,eId:string)=>{

            if(!m){
                return;
            }
            if(type==='clearAll'){
                setObj(undefined);
            }else if(type==='resetAll'){
                setObj(undefined);
                get();
            }else if(eCollection===collection && eId===strId){// (this).{fKey} -> baseObj.Id
                if(type==='delete'){
                    setObj(undefined);
                }
            }else if(eCollection===refCollection && objs){
                if(ids?.includes(eId)){
                    get();
                }
            }
        }

        db.addListener(listener);


        return ()=>{
            m=false;
            db.removeListener(listener);
        }
    },[collection,id,db,refCollection,property,foreignKey]);

    return obj;
}



export function useObjSingleRef<T,TRef>(
    collection:string,
    id:IdParam,
    refCollection:string,
    property:keyof(T)|null,
    foreignKey:keyof(T))
    :TRef|null|undefined
{
    const db=useClientDb();

    const [obj,setObj]=useState<TRef|null|undefined>(undefined);

    useEffect(()=>{
        let m=true;
        setObj(undefined);
        let rObj:TRef|null=null;
        let pk:string|null=null;
        const get=async ()=>{
            rObj=await db.getObjRefSingle<T,TRef>(collection,id,refCollection,property,foreignKey);
            pk=db.getPrimaryKey(refCollection,rObj);
            if(m){
                setObj(rObj);
            }
        };
        get();

        const strId=id?.toString();
        const listener=(type:ObjEventType,eCollection:string,eId:string,obj:any)=>{
            if(!m){
                return;
            }
            if(type==='clearAll'){
                setObj(undefined);
            }else if(type==='resetAll'){
                setObj(undefined);
                get();
            }else if(eCollection===collection && eId===strId){// baseObj.{fKey} -> (this).Id
                if(type==='set' || type==='reset'){
                    // fKey could have changed to do full refresh
                    setObj(undefined);
                    get();
                }else if(type==='delete'){
                    setObj(undefined);
                }
            }else if(eCollection===refCollection && pk===eId){
                if(type==='set'){
                    setObj(obj);
                }else if(type==='reset'){
                    setObj(undefined);
                    get();
                }else if(type==='delete'){
                    setObj(undefined);
                }
            }
        }

        db.addListener(listener);


        return ()=>{
            m=false;
            db.removeListener(listener);
        }
    },[collection,id,db,refCollection,property,foreignKey]);

    return obj;
}