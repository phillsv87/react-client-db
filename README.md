# react-client-db
A smart client database that connects to REST APIs and provided realtime updates through a collection of hooks

## SQLite adapters
When creating a new instance of a ClientDb you will need to provide a openDatabase adapter.
you can use an existing adapter from within the adapters folder or create your own.

``` typescript

// react-native-sqlite-2 adapter
const client=new ClientDb(httpClient,null,openDatabaseReactNativeSqlite2);

// expo-sqlite adapter
const client=new ClientDb(httpClient,null,openDatabaseExpoSqlite);

```

## Known issues
Using expo-sqlite and android is not supported since the expo-sqlite binary on android is not
compiled with JSON1 extension.
