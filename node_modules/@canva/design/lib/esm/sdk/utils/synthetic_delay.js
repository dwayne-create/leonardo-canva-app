export function createSyntheticDelay(timeout) {
    return ()=>new Promise((res)=>setTimeout(res, timeout));
}
