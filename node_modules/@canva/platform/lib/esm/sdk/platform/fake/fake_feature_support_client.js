export class FakeFeatureSupportClient {
    isSupported(...features) {
        return true;
    }
    registerOnSupportChange(onSupportChange) {
        onSupportChange();
        return ()=>{};
    }
}
