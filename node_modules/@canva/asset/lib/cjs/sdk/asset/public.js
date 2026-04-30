"use strict";
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
    get findFonts () {
        return findFonts;
    },
    get getTemporaryUrl () {
        return getTemporaryUrl;
    },
    get openColorSelector () {
        return openColorSelector;
    },
    get requestFontSelection () {
        return requestFontSelection;
    },
    get upload () {
        return upload;
    }
});
const { canva_sdk } = window;
const upload = canva_sdk.asset.v2.content.upload;
const getTemporaryUrl = canva_sdk.asset.v2.content.getTemporaryUrl;
const findFonts = canva_sdk.asset.v2.content.findFonts;
const requestFontSelection = canva_sdk.asset.v2.content.requestFontSelection;
const openColorSelector = canva_sdk.asset.v2.content.openColorSelector;
