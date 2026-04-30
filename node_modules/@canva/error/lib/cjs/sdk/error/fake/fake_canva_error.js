"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "FakeCanvaError", {
    enumerable: true,
    get: function() {
        return FakeCanvaError;
    }
});
class FakeCanvaError extends Error {
    constructor(opts){
        const message = `Fake mode error - [${opts.code}]:  ${opts.message}`;
        super(message), this.name = 'FakeCanvaError';
        this.rawMessage = opts.message;
        this.code = opts.code;
    }
}
