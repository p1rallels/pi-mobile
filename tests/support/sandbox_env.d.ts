export declare const isInheritedPiKey: (key: string) => boolean;
export declare function scrubbedEnv(env?: Record<string, string | undefined>): Record<string, string>;
export declare function sandboxServerEnv(root: string, overrides: Record<string, string>): Record<string, string>;
