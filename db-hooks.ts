import { useContext, useEffect, useRef, useState } from "react";
import ClientDb, { ClientDbContext } from "./ClientDb";
import { IdParam, ObjEventType, PauseHook } from "./db-types";

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
export function useObj<T>(collection:string,id:IdParam,endpoint?:string):T|null|undefined
{
    const db=useClientDb();

    const [obj,setObj]=useState<T|null|undefined>(undefined);
    const hasPaused=useRef(false);

    useEffect(()=>{
        if(id===PauseHook){
            hasPaused.current=true;
            return;
        }
        let m=true;
        if(!hasPaused.current){
            setObj(undefined);
        }
        const get=async ()=>{
            const obj=await db.getObjAsync<T>(collection,id,endpoint);
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
                get();
            }else if(type==='resetCollection' && eCollection===collection){
                get();
            }else if(eCollection===collection && eId===strId){
                if(type==='set' || type==='update'){
                    setObj(obj);
                }else if(type==='reset'){
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
    },[collection,id,endpoint,db]);

    return obj;
}

/**
 *
 * @param enabled
 * @param collection
 * @param endpoint
 * @param isCollection
 * @param cacheKey
 * @param cacheId
 * @returns
 */
export function useMappedObj<T>(
    enabled:boolean,
    collection:string,
    endpoint:string,
    isCollection:boolean,
    cacheKey:string|null=null,
    cacheId:number|null=null)
    :T|null|undefined
{
    const db=useClientDb();

    const [obj,setObj]=useState<T|null|undefined>(undefined);

    useEffect(()=>{
        if(!enabled){
            return;
        }

        let m=true;
        setObj(undefined);
        const get=async ()=>{
            const obj=await db.getMappedObj<T>(endpoint,isCollection,cacheKey||'MAPPED:'+endpoint,cacheId||-1,collection);
            if(m){
                setObj(obj);
            }
        };
        get();

        const listener=(type:ObjEventType,eCollection:string)=>{
            if(!m){
                return;
            }
            if(type==='clearAll'){
                setObj(undefined);
            }else if(type==='resetAll'){
                get();
            }else if(type==='resetCollection' && eCollection===collection){
                get();
            }
            // todo - maybe do something more here
        }

        db.addListener(listener);


        return ()=>{
            m=false;
            db.removeListener(listener);
        }
    },[enabled,endpoint,isCollection,collection,cacheKey,cacheId,db]);

    return obj;
}

export function useObjCollectionRef<T,TRef>(
    collection:string,
    id:IdParam,
    refCollection:string,
    property:keyof(T)|string,
    foreignKey:keyof(TRef),
    endpoint?:string)
    :TRef[]|null|undefined
{
    const db=useClientDb();

    const [obj,setObj]=useState<TRef[]|null|undefined>(undefined);
    const hasPaused=useRef(false);

    useEffect(()=>{
        if(id===PauseHook){
            hasPaused.current=true;
            return;
        }
        let m=true;
        if(!hasPaused.current){
            setObj(undefined);
        }
        let objs:TRef[]|null=null;
        let ids:string[]|null=null;
        const get=async (clearCache?:boolean)=>{
            objs=await db.getObjRefCollection<T,TRef>(
                collection,id,refCollection,property,foreignKey,clearCache,endpoint);
            ids=objs?.map(o=>db.getPrimaryKey(refCollection,o))||null;
            if(m){
                setObj(objs);
            }
        };
        get();

        const strId=id?.toString();
        const listener=(type:ObjEventType,eCollection:string,eId:string,obj:any,includeRefs:boolean)=>{

            if(!m){
                return;
            }
            if(type==='clearAll'){
                setObj(undefined);
            }else if(type==='resetAll'){
                get();
            }else if(type==='resetCollection' && eCollection===collection){
                get();
            }else if(eCollection===collection && eId===strId){// (this).{fKey} -> baseObj.Id
                if(type==='delete'){
                    setObj(undefined);
                }else if(includeRefs){
                    get();
                }
            }else if(eCollection===refCollection && objs){
                if(ids?.includes(eId) || obj?.[foreignKey]===id){
                    get(true);
                }
            }
        }

        db.addListener(listener);


        return ()=>{
            m=false;
            db.removeListener(listener);
        }
    },[collection,id,db,refCollection,property,foreignKey,endpoint]);

    return obj;
}



export function useObjSingleRef<T,TRef>(
    collection:string,
    id:IdParam,
    refCollection:string,
    property:keyof(T)|null,
    foreignKey:keyof(T),
    endpoint?:string)
    :TRef|null|undefined
{
    const db=useClientDb();

    const [obj,setObj]=useState<TRef|null|undefined>(undefined);
    const hasPaused=useRef(false);

    useEffect(()=>{
        if(id===PauseHook){
            hasPaused.current=true;
            return;
        }
        let m=true;
        if(!hasPaused.current){
            setObj(undefined);
        }
        let rObj:TRef|null=null;
        let pk:string|null=null;
        const get=async ()=>{
            rObj=await db.getObjRefSingle<T,TRef>(
                collection,id,refCollection,property,foreignKey,endpoint);
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
                get();
            }else if(type==='resetCollection' && eCollection===collection){
                get();
            }else if(eCollection===collection && eId===strId){// baseObj.{fKey} -> (this).Id
                if(type==='set' || type==='reset' || type==='update'){
                    // fKey could have changed to do full refresh
                    get();
                }else if(type==='delete'){
                    setObj(undefined);
                }
            }else if(eCollection===refCollection && pk===eId){
                if(type==='set' || type==='update'){
                    setObj(obj);
                }else if(type==='reset'){
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
    },[collection,id,db,refCollection,property,foreignKey,endpoint]);

    return obj;
}
