import { LATEST_VERSION } from './version';
export * from './public';
window.__canva__?.sdkRegistration?.registerPackageVersion('error', LATEST_VERSION, 'ga');
