export function getCanvaSdk() {
    return window.canva_sdk;
}
export function assertIsTestCanvaSdk() {
    if (window.__canva__?.uiKit) {
        const CanvaError = getCanvaSdk()?.error?.v2.CanvaError;
        throw new CanvaError({
            code: 'failed_precondition',
            message: "Canva App SDK: You're attempting to call `initTestEnvironment` in a non-test environment, such as in production. This method should be called in test environments, once and only once. For more info refer to https://canva.dev/docs/apps/testing/"
        });
    }
}
export function injectFakeAPIClients(clients) {
    bindMethodsToClients(clients);
    window.canva_sdk = {
        ...getCanvaSdk(),
        ...clients
    };
}
export function bindMethodsToClients(objectToBind) {
    if (typeof objectToBind !== 'object' || objectToBind == null)
        return;
    const classMethods = new Set();
    let currentPrototype = Object.getPrototypeOf(objectToBind);
    while(currentPrototype && currentPrototype !== Object.prototype){
        Object.getOwnPropertyNames(currentPrototype).forEach((method)=>classMethods.add(method));
        currentPrototype = Object.getPrototypeOf(currentPrototype);
    }
    classMethods.delete('constructor');
    for (const method of classMethods) {
        const originalFn = objectToBind[method];
        if (typeof originalFn === 'function') Object.defineProperty(objectToBind, method, {
            value: (...args)=>{
                return originalFn.call(objectToBind, ...args);
            }
        });
    }
    Object.values(objectToBind).forEach(bindMethodsToClients);
}
