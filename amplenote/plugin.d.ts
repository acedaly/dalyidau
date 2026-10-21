// Types for tests, which run the plugin against a stand-in for Amplenote's `app`.
interface AmplenotePlugin {
    VERSION: string;
    onNavigate(app: unknown): Promise<void>;
    appOption: Record<string, (this: AmplenotePlugin, app: unknown) => Promise<void>>;
    _nextRun: number;
}
declare const plugin: AmplenotePlugin;
export default plugin;
