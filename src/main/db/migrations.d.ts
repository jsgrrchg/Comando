export interface DatabaseMigration {
    readonly id: string;
    readonly sql: string;
}
export declare const databaseMigrations: readonly DatabaseMigration[];
