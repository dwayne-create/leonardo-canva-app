import { injectError } from '../fake/inject';
import { assertIsTestCanvaSdk, injectFakeAPIClients } from '../../utils/canva_sdk';
export function initTestEnvironment() {
    assertIsTestCanvaSdk();
    injectFakeAPIClients(injectError());
}
