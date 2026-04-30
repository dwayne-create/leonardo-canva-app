"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "FakeAppProcessClient", {
    enumerable: true,
    get: function() {
        return FakeAppProcessClient;
    }
});
class FakeAppProcessClient {
    async requestClose(target, params) {
        await Promise.resolve();
    }
    registerOnStateChange(target, callback) {
        return async ()=>{
            await Promise.resolve();
        };
    }
    registerOnMessage(callback) {
        return async ()=>{
            await Promise.resolve();
        };
    }
    broadcastMessage(message) {}
    constructor(){
        this.current = {
            getInfo: ()=>({
                    processId: 'test-process-id',
                    surface: 'object_panel'
                }),
            requestClose: async (params)=>{
                await Promise.resolve();
            },
            setOnDispose: (callback)=>async ()=>{
                    await Promise.resolve();
                }
        };
    }
}
