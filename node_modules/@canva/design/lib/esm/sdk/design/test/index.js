import { createFakeDesignClients } from '../fake/create';
import { assertIsTestCanvaSdk, injectFakeAPIClients } from '../../utils/canva_sdk';
export function initTestEnvironment() {
    assertIsTestCanvaSdk();
    injectFakeAPIClients(createFakeDesignClients());
}
