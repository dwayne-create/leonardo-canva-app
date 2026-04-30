import { FakeContentClient } from './fake_content_client';
export function createFakeAssetClients() {
    const v2 = {
        content: new FakeContentClient()
    };
    return {
        asset: {
            v2
        }
    };
}
