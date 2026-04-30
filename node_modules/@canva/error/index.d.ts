/** @public */
declare interface BaseCanvaError extends Error {
    code: ErrorCode;

}

/**
 * @public
 * An error thrown by the Apps SDK.
 */
export declare const CanvaError: typeof CanvaErrorClass;

/**
 * @public
 * An error thrown by the Apps SDK.
 */
declare class CanvaErrorClass extends Error implements BaseCanvaError {
    /**
     * A code that identifies why the error was thrown.
     */
    readonly code: ErrorCode;

    constructor(opts: {
        code: ErrorCode;
        message: string;
    });
}

/**
 * @public
 * An error code that identifies why an error was thrown by the Apps SDK.
 *
 * @remarks
 * The possible error codes include:
 *
 * - `"bad_external_service_response"` - A response from an external service is invalid or malformed.
 * - `"bad_request"` - The app made a request with invalid or malformed inputs.
 * - `"failed_precondition"` - The requested operation can't be performed because a precondition hasn't been met.
 * - `"internal_error"` - An error occurred within the Apps SDK's internal implementation.
 * - `"not_found"` - The specified resource couldn't be found.
 * - `"not_allowed"` - The app isn't allowed to perform the requested operation.
 * - `"permission_denied"` - The app isn't allowed to perform the requested operation because the appropriate permissions aren't accepted.
 * - `"missing_permission"` - The app isn't allowed to perform the requested operation because the appropriate permissions aren't set in the app config.
 * - `"quota_exceeded"` - The app or user has exceeded their allocated quota for a resource or service.
 * - `"rate_limited"` - The app attempted too many operations within a certain period of time.
 * - `"timeout"` - The requested operation took too long to complete.
 * - `"unsupported_surface"` - The requested operation isn't supported on the current surface.
 * - `"unsupported_page_type"` - The requested operation isn't supported on the current page.
 * - `"user_offline"` - The requested operation can't be performed because the user is offline.
 */
export declare type ErrorCode = 'bad_external_service_response' | 'bad_request' | 'failed_precondition' | 'internal_error' | 'not_found' | 'not_allowed' | 'permission_denied' | 'missing_permission' | 'quota_exceeded' | 'rate_limited' | 'timeout' | 'unsupported_surface' | 'unsupported_page_type' | 'user_offline';

export { }
