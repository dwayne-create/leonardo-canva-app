"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "initTestEnvironment", {
    enumerable: true,
    get: function() {
        return initTestEnvironment;
    }
});
const _create = require('../fake/create');
const _canva_sdk = require('../../utils/canva_sdk');
function initTestEnvironment() {
    (0, _canva_sdk.assertIsTestCanvaSdk)();
    (0, _canva_sdk.injectFakeAPIClients)((0, _create.createFakeDesignClients)());
}
