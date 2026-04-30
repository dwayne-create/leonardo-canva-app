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
    get LATEST_VERSION () {
        return LATEST_VERSION;
    },
    get LATEST_VERSION_ALPHA () {
        return LATEST_VERSION_ALPHA;
    },
    get LATEST_VERSION_BETA () {
        return LATEST_VERSION_BETA;
    }
});
const LATEST_VERSION = '2.2.1';
const LATEST_VERSION_BETA = 'NONE';
const LATEST_VERSION_ALPHA = 'NONE';
