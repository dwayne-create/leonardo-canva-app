import { FakeAppProcessClient } from './fake_app_process_client';
import { FakeFeatureSupportClient } from './fake_feature_support_client';
import { FakeNotificationClient } from './fake_notification_client';
import { FakePlatformClient } from './fake_platform_client';
export function createFakePlatformClients() {
    const appProcess = new FakeAppProcessClient();
    const platform = new FakePlatformClient();
    const features = new FakeFeatureSupportClient();
    const notification = new FakeNotificationClient();
    const i18n = undefined;
    return {
        platform: {
            v2: {
                platform,
                appProcess,
                i18n,
                features,
                notification
            }
        }
    };
}
