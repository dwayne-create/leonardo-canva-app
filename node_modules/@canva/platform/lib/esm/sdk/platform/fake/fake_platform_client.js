export class FakePlatformClient {
    async requestOpenExternalUrl(options) {
        await Promise.resolve();
        return {
            status: 'completed'
        };
    }
    getPlatformInfo() {
        return {
            canAcceptPayments: true
        };
    }
}
