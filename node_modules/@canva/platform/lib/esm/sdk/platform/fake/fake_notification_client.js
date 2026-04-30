export class FakeNotificationClient {
    async addToast(options) {
        return {
            status: 'completed'
        };
    }
}
