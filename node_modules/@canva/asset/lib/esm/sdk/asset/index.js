import { LATEST_VERSION } from './version';
export * from './public';
window.__canva__?.sdkRegistration?.registerPackageVersion('asset', LATEST_VERSION, 'ga');
