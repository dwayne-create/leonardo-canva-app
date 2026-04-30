import { FakeCanvaError } from './fake_canva_error';
export function injectError() {
    return {
        error: {
            v2: {
                CanvaError: FakeCanvaError
            }
        }
    };
}
