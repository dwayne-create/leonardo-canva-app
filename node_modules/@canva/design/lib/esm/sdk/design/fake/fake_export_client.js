export class FakeExportClient {
    async queueDocument(request) {
        await this.delay();
        return {
            status: 'completed',
            exportBlobs: fakeExportBlobs
        };
    }
    async requestExport(request) {
        await this.delay();
        return {
            status: 'completed',
            exportBlobs: fakeExportBlobs
        };
    }
    constructor(delay){
        this.delay = delay;
    }
}
const fakeExportBlobs = [
    {
        url: 'https://canva.dev/docs/apps/testing/'
    }
];
