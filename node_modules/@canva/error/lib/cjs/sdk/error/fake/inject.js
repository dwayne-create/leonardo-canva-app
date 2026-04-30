"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "injectError", {
    enumerable: true,
    get: function() {
        return injectError;
    }
});
const _fake_canva_error = require("./fake_canva_error");
function injectError() {
    return {
        error: {
            v2: {
                CanvaError: _fake_canva_error.FakeCanvaError
            }
        }
    };
}
