export const SpecialIdPrefix='::SPECIAL::ID::';

export const PauseHook=SpecialIdPrefix+'PauseHook';

export type IdParam=number|string|null|undefined;

export interface IHttp
{
    getAsync:<T>(path:string,data?:any)=>Promise<T>;

    postAsync:<T>(path:string,data?:any)=>Promise<T>;

    putAsync:<T>(path:string,data?:any)=>Promise<T>;

    patchAsync:<T>(path:string,data?:any)=>Promise<T>;

    deleteAsync:<T>(path:string,data?:any)=>Promise<T>;
}

export type EndPointBuilder=(collection:string,id:IdParam)=>string;

export interface DbCollectionRelation
{
    collection:string;
    depCollection:string;
    resetAll?:boolean;
}

export interface DbConfig
{
    databaseName?:string;
    crudPrefix?:string;
    primaryKey?:string;
    getPrimaryKey?:((collection:string,obj:any)=>string|null)|null;
    primaryKeyMap?:{[collection:string]:string}|null;
    endPointMap?:{[collection:string]:string|EndPointBuilder};
    collectionRelations?:DbCollectionRelation[];
    defaultTTLMinutes?:number;
}

export interface DbRecord
{
    expires:number;// timestamp
    collection:string;// index
    refCollection:string|null;
    objId:string;// index
    obj:string;// json
}

export interface DbMemRecord
{
    expires:number;// timestamp
    collection:string;// index
    refCollection:string|null;
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
    'clearAll'|

    // Resets all objects in a collection. objects with a matching collection should be
    // retrieved from their data source
    'resetCollection';

export type ObjListener=(type:ObjEventType,collection:string,id:string,obj:any,includeRefs:boolean)=>void;

export interface DbSettingRecord
{
    name:string;
    value:string;
}
