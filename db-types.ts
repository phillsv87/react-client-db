export type IdParam=number|string|null|undefined;

export interface IHttp
{
    getAsync:<T>(path:string,data?:any)=>Promise<T>;

    postAsync:<T>(path:string,data?:any)=>Promise<T>;

    putAsync:<T>(path:string,data?:any)=>Promise<T>;

    patchAsync:<T>(path:string,data?:any)=>Promise<T>;

    deleteAsync:<T>(path:string,data?:any)=>Promise<T>;
}

export interface DbConfig
{
    databaseName?:string;
    crudPrefix?:string;
    primaryKey?:string;
    getPrimaryKey?:((collection:string)=>string)|null;
}

export interface DbRecord
{
    expires:number;// timestamp
    collection:string;// index
    objId:string;// index
    obj:string;// json
}

export interface DbMemRecord
{
    expires:number;// timestamp
    collection:string;// index
    objId:string;// index
    obj:any;
}

export interface DbRecordRef
{
    ids?:string[];
    id?:string;
}

export type ObjEventType=
    // An object was set
    'set'|

    // An object was reset and should be retrieved from its data source
    'reset'|

    // All objects were reset and all objects should be retrieved from their data source
    'resetAll'|

    // An object was deleted from its data source
    'delete'|

    // All objects were cleared but should not be retrieved from their data source.
    // This is a utility event used to clear the cache db.
    'clearAll';

export type ObjListener=(type:ObjEventType,collection:string,id:string,obj:any)=>void;
