"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: Object.getOwnPropertyDescriptor(all, name).get
    });
}
_export(exports, {
    get appProcess () {
        return appProcess;
    },
    get features () {
        return features;
    },
    get getPlatformInfo () {
        return getPlatformInfo;
    },
    get notification () {
        return notification;
    },
    get requestOpenExternalUrl () {
        return requestOpenExternalUrl;
    }
});
const appProcess = canva_sdk.platform.v2.appProcess;
const features = canva_sdk.platform.v2.features;
const notification = canva_sdk.platform.v2.notification;
const requestOpenExternalUrl = canva_sdk.platform.v2.platform.requestOpenExternalUrl;
const getPlatformInfo = canva_sdk.platform.v2.platform.getPlatformInfo;
