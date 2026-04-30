/**
 * @public
 * Provides methods for interacting with an app process.
 */
export declare interface AppProcess {
    /**
     * The current app process.
     */
    readonly current: CurrentAppProcess;
    /**
     * @public
     * Requests the termination of the specified app process.
     *
     * @param target - The ID of an app process.
     * @param params - Parameters to pass to the `setOnDispose` callback. Any kind of structured data can be passed via this property.
     *
     * @remarks
     * Once called, this method:
     *
     * 1. Transitions the state of the process to `"closing"`.
     * 2. Invokes all registered `setOnDispose` callbacks.
     * 3. Waits for the process to finish closing.
     * 4. Transitions the state of the process to `"closed"`.
     *
     * Each time the state changes, all of the `registerOnStateChange` callbacks are called.
     *
     * @example Close a process
     * ```typescript
     * import { appProcess, type AppProcessId } from '@canva/platform';
     *
     * const placeholderProcessId = "PLACEHOLDER_PROCESS_ID" as AppProcessId;
     *
     * await appProcess.requestClose(placeholderProcessId, { reason: 'completed' });
     * ```
     *
     * @example Pass structured data to a process as it closes
     * ```typescript
     * import { appProcess, type AppProcessId, type CloseParams } from '@canva/platform';
     *
     * type DetailedCloseParams = CloseParams & {
     *   savePoint: string;
     *   timestamp: number;
     *   userInitiated: boolean;
     * };
     *
     * const placeholderProcessId = "PLACEHOLDER_PROCESS_ID" as AppProcessId;
     *
     * await appProcess.requestClose<DetailedCloseParams>(placeholderProcessId, {
     *   reason: 'completed',
     *   savePoint: 'auto_backup_1',
     *   timestamp: Date.now(),
     *   userInitiated: true
     * });
     * ```
     */
    requestClose<T extends CloseParams>(target: AppProcessId, params: T): Promise<void>;
    /**
     * @public
     * Registers a callback that runs when the state of the specified app process changes.
     *
     * @param target - The ID of an app process.
     * @param callback - The callback to run when the state of the process changes.
     *
     * @returns
     * A disposer function that cleans up the registered callback.
     *
     * @example Listen for process state changes
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * const stateDisposer = appProcess.registerOnStateChange(
     *   processId,
     *   ({ state }) => {
     *     switch (state) {
     *       case 'opening':
     *         // Process is starting up
     *         break;
     *       case 'open':
     *         // Process is active and visible
     *         break;
     *       case 'closing':
     *         // Process is about to close
     *         // Save state, cleanup resources
     *         break;
     *       case 'closed':
     *         // Process has been terminated
     *         // Final cleanup if needed
     *         break;
     *     }
     *   }
     * );
     *
     * // Later: cleanup the listener
     * await stateDisposer();
     * ```
     */
    registerOnStateChange(target: AppProcessId, callback: OnStateChangeCallback): () => Promise<void>;
    /**
     * @public
     * Registers a callback that listens for broadcasted messages.
     *
     * @param callback - The callback that listens for broadcasted messages.
     *
     * @returns
     * A disposer function that cleans up the registered callback.
     *
     * @example Listen for inter-process messages
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * const messageDisposer = appProcess.registerOnMessage(async (sender, message) => {
     *   const { appProcessId, surface } = sender;
     *   // Handle message from other process
     * });
     *
     * // Later: cleanup the listener
     * await messageDisposer();
     * ```
     */
    registerOnMessage(callback: OnMessageCallback): () => Promise<void>;
    /**
     * @public
     * Broadcasts a message to all of the app's active processes, not including the current process.
     *
     * @param message - The message to be broadcasted. This can be any kind of structured data.
     *
     * @example Broadcast primitive values
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * // Broadcasting a string
     * appProcess.broadcastMessage('REFRESH_REQUESTED');
     *
     * // Broadcasting a number
     * appProcess.broadcastMessage(42);
     *
     * // Broadcasting a boolean
     * appProcess.broadcastMessage(true);
     * ```
     *
     * @example Broadcast simple objects
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * appProcess.broadcastMessage({
     *   id: 'user-123',
     *   name: 'John Doe',
     *   active: true
     * });
     * ```
     *
     * @example Broadcast complex objects
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * appProcess.broadcastMessage({
     *   type: 'DOCUMENT_UPDATE',
     *   timestamp: Date.now(),
     *   payload: {
     *     documentId: 'doc-123',
     *     version: 2,
     *     metadata: {
     *       title: 'Project Alpha',
     *       tags: ['draft', 'review-needed'],
     *       collaborators: [
     *         { id: 'user-1', role: 'editor' },
     *         { id: 'user-2', role: 'viewer' }
     *       ]
     *     }
     *   }
     * });
     * ```
     */
    broadcastMessage(message: any): void;
}

/**
 * @public
 * Provides methods for interacting with app processes.
 */
export declare const appProcess: AppProcess;

/**
 * @public
 * The unique identifier of an app process.
 */
export declare type AppProcessId = string & {
    __appProcessId: never;
};

/**
 * @public
 * Information about an app process.
 */
export declare type AppProcessInfo<T> = {
    /**
     * The surface on which the app process is running.
     */
    surface: AppSurface;
    /**
     * The unique identifier of the app process.
     */
    processId: AppProcessId;
    /**
     * Parameters passed to the app process when it was opened.
     */
    launchParams?: T;
};

/**
 * @public
 * The type of surface on which an app process can run.
 *
 * @remarks
 * The possible surfaces include:
 *
 * - `"headless"` - A surface for when there is no visible user interface.
 * - `"object_panel"` - A surface that renders a user interface in the side panel of the Canva editor.
 * - `"selected_image_overlay"` - A surface that can be opened on top of a selected image.
 */
export declare type AppSurface = 'object_panel' | 'selected_image_overlay' | 'headless';

/**
 * @public
 * Parameters passed to the `setOnDispose` callback when a process is about to close.
 */
export declare type CloseParams = {
    /**
     * The reason the app process is closing.
     */
    reason: CloseReason;
};

/**
 * @public
 * The reason why an app process is closing.
 *
 * @remarks
 * The possible reasons include:
 *
 * - `"completed"` - Indicates that a workflow has been completed and unsaved changes should be saved.
 * - `"aborted"` - Indicates that a workflow has been abandoned and unsaved changes should be discarded.
 */
export declare type CloseReason = 'completed' | 'aborted';

/**
 * @public
 * Provides methods for interacting with the current app process.
 */
export declare type CurrentAppProcess = {
    /**
     * @public
     * Returns information about the current app process.
     *
     * @example Get current process information
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * const currentProcess = appProcess.current;
     * const processInfo = currentProcess.getInfo();
     * ```
     *
     * @example Check current process surface type
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * const currentProcess = appProcess.current;
     * const { surface } = currentProcess.getInfo();
     *
     * if (surface === 'object_panel') {
     *   // This app is running in the object panel
     * }
     * ```
     *
     * @example Read current process launch parameters
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * type MyLaunchParams ={
     *   mode: 'edit' | 'view';
     *   id: string;
     * }
     *
     * const currentProcess = appProcess.current;
     * const { launchParams } = currentProcess.getInfo<MyLaunchParams>();
     *
     * if (launchParams) {
     *   const { mode, id } = launchParams;
     *   // Use launch parameters
     * }
     * ```
     */
    getInfo<T>(): AppProcessInfo<T>;
    /**
     * @public
     * Requests the termination of the current process.
     *
     * @param params - Parameters to pass to the `setOnDispose` callback. Any structured data can be passed via this property.
     *
     * @remarks
     * Once called, this method:
     *
     * 1. Transitions the state of the process to `"closing"`.
     * 2. Invokes all registered `setOnDispose` callbacks.
     * 3. Waits for the process to finish closing.
     * 4. Transitions the state of the process to `"closed"`.
     *
     * Each time the state changes, all of the `registerOnStateChange` callbacks are called.
     *
     * @example Close current process
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * await appProcess.current.requestClose({ reason: 'completed' });
     * ```
     *
     * @example Pass structured data to current process as it closes
     * ```typescript
     * import { appProcess, type CloseParams } from '@canva/platform';
     *
     * type DetailedCloseParams = CloseParams & {
     *   metadata: {
     *     savePoint: string;
     *     timestamp: number;
     *     userInitiated: boolean;
     *   }
     * };
     *
     * await appProcess.current.requestClose<DetailedCloseParams>({
     *   reason: 'completed',
     *   metadata: {
     *     savePoint: 'auto_backup_1',
     *     timestamp: Date.now(),
     *     userInitiated: true
     *   }
     * });
     * ```
     */
    requestClose<T extends CloseParams>(params: T): Promise<void>;
    /**
     * @public
     * Registers a callback that runs when the current app process is about to close.
     *
     * @param callback - The callback to run when the current app process is about to close.
     *
     * @returns
     * A disposer function that cleans up the registered callback.
     *
     * @remarks
     * - Apps can't register multiple callbacks.
     * - If an app attempts to register multiple callbacks, only the last callback will be registered.
     * - The app process will remain open until the callback resolves or a timeout error occurs.
     * - The complete execution of the callback is not guaranteed as some user actions (e.g. closing tabs) may close the process prematurely.
     *
     * @example Handle process cleanup
     * ```typescript
     * import { appProcess } from '@canva/platform';
     *
     * const cleanupDisposer = appProcess.current.setOnDispose(async (params) => {
     *   if (params.reason === 'completed') {
     *     await saveChanges();
     *   }
     * });
     *
     * // Later: cleanup the listener
     * await cleanupDisposer();
     * ```
     */
    setOnDispose<T extends CloseParams>(callback: OnDisposeCallback<T>): () => Promise<void>;
};

/**
 * @public
 * Disposes an event listener.
 */
declare type Disposer = () => void;

/**
 * @public
 * An SDK method that can be inspected for feature support.
 */
export declare type Feature = (...args: any[]) => unknown;

/**
 * @public
 * Provides methods for checking if a feature is supported.
 */
export declare const features: FeatureSupport;

/**
 * @public
 * Provides methods for checking if an SDK method is supported in the current context.
 */
export declare interface FeatureSupport {
    /**
     * @public
     * Checks if the specified SDK methods are supported in the current context.
     *
     * @param features - The SDK methods to be checked for support.
     *
     * @example Checking a single feature
     * ```typescript
     * import { features } from '@canva/platform';
     * import { addElementAtPoint } from '@canva/design';
     *
     * const isSupported = features.isSupported(addElementAtPoint);
     * ```
     *
     * @example Checking multiple features
     * ```typescript
     * import { features } from '@canva/platform';
     * import { addElementAtPoint, addElementAtCursor } from '@canva/design';
     *
     * const areSupported = features.isSupported(addElementAtPoint, addElementAtCursor);
     * ```
     */
    isSupported(...features: Feature[]): boolean;
    /**
     * @public
     * Registers a callback that runs when the context changes and an SDK method becomes supported or unsupported.
     *
     * @param onSupportChange - The callback that runs when the support status of an SDK method changes.
     *
     * @example Monitoring feature support changes
     * ```typescript
     * import { features } from '@canva/platform';
     * import { addElementAtPoint } from '@canva/design';
     *
     * const supportDisposer = features.registerOnSupportChange(() => {
     *   const isNowSupported = features.isSupported(addElementAtPoint);
     *   // Update UI based on new support status
     * });
     *
     * // Later: cleanup the listener
     * await supportDisposer();
     * ```
     */
    registerOnSupportChange(onSupportChange: () => void): Disposer;
}

/**
 * @public
 * Returns information about the platform on which the app is running.
 *
 * @example Get platform information
 * ```typescript
 * import { getPlatformInfo } from '@canva/platform';
 *
 * const platformInfo = await getPlatformInfo();
 * ```
 *
 * @example Check if app is running on platform that allows payments
 * ```typescript
 * import { getPlatformInfo } from '@canva/platform';
 *
 * const platformInfo = await getPlatformInfo();
 *
 * if (platformInfo.canAcceptPayments) {
 *   // Show payment-related UI elements
 * } else {
 *   // Hide payment-related UI elements
 * }
 * ```
 */
export declare const getPlatformInfo: () => PlatformInfo;

/**
 * @public
 * Provides methods for interacting with notifications.
 */
export declare const notification: NotificationClient;

/**
 * @public
 *
 * Provides methods for interacting with notifications.
 */
export declare interface NotificationClient {
    /**
     * @public
     *
     * A method that shows a toast notification to the user.
     *
     * @example
     * ```tsx
     * import { notification } from '@canva/platform';
     * import type { ToastRequest } from '@canva/platform';
     *
     * const showToast = () => {
     *   const request: ToastRequest = {
     *     messageText: "Hello world!",
     *   };
     *   notification.addToast(request);
     * };
     *
     * <Button onClick={() => showToast()}>Show Toast</Button>
     * ```
     */
    addToast: (request: ToastRequest) => Promise<ToastResponse>;
}

/**
 * @public
 * A callback that runs when an app process is about to close.
 * @param opts - Parameters passed to the `setOnDispose` callback when a process is about to close.
 */
export declare type OnDisposeCallback<T extends CloseParams> = (opts: T) => Promise<void>;

/**
 * @public
 * A callback that runs when an app process receives a broadcasted message.
 *
 * @param sender - Information about the process that sent the message.
 *   - sender.appProcessId - The ID of the process that sent the message.
 *   - sender.surface - The surface of the process that sent the message.
 * @param message - The broadcasted message.
 */
export declare type OnMessageCallback = (sender: {
    appProcessId: AppProcessId;
    surface: AppSurface;
}, message: any) => Promise<void>;

/**
 * @public
 * A callback that runs when the state of a process changes.
 *
 * @param opts - Information about the state change.
 *   - opts.state - The state of the process.
 */
export declare type OnStateChangeCallback = (opts: {
    state: ProcessState;
}) => void;

/**
 * @public
 * The result when a user doesn't agree to navigate to an external URL.
 */
export declare type OpenExternalUrlAborted = {
    /**
     * The status of the request.
     */
    status: 'aborted';
};

/**
 * @public
 * The result when a user agrees to navigate to an external URL.
 */
export declare type OpenExternalUrlCompleted = {
    /**
     * The status of the request.
     */
    status: 'completed';
};

/**
 * @public
 * Options for prompting the user to open an external URL.
 */
export declare type OpenExternalUrlRequest = {
    /**
     * The URL to open.
     */
    url: string;
};

/**
 * @public
 * The result of prompting the user to open an external URL.
 */
export declare type OpenExternalUrlResponse = OpenExternalUrlCompleted | OpenExternalUrlAborted;

/**
 * @public
 * Information about the platform on which the app is running.
 */
export declare type PlatformInfo = {
    /**
     * If `true`, the app is allowed to directly link to payment and upgrade flows.
     *
     * @remarks
     * This property is always `true` when the app is running in a web browser, but may otherwise be `false` in
     * order to comply with the policies of the platforms on which Canva is available. For example, some platforms
     * only allow payment-related actions that use their own payment mechanisms and apps are therefore not allowed
     * to render payment-related call-to-actions while running on those platforms.
     *
     * @example
     * ```ts
     * const info = getPlatformInfo();
     *
     * if (info.canAcceptPayments) {
     *   // Display payment links and upgrade flows
     * } else {
     *   // Hide payment links and upgrade flows
     *   // Optionally, show an appropriate message
     * }
     * ```
     */
    canAcceptPayments: boolean;
};

/**
 * @public
 * The state of an app process.
 *
 * @remarks
 * The possible states include:
 *
 * - `"opening"` - The app process is opening.
 * - `"open"` - The app process is open, active, and visible on the designated surface.
 * - `"closing"` - The app process is closing.
 * - `"closed"` - The app process has been closed and is no longer active.
 *
 * While a process is closing, it won't receive any events or messages from other processes.
 */
export declare type ProcessState = 'opening' | 'open' | 'closing' | 'closed';

/**
 * @public
 * Opens an external URL.
 *
 * @remarks
 * The URL is opened natively, such as in a new browser tab on desktop or in a browser sheet on mobile.
 *
 * In some browsers, the user must enable popup permissions before any URL can be opened.
 *
 * @example Open an external URL
 * ```typescript
 * import { requestOpenExternalUrl } from '@canva/platform';
 *
 * await requestOpenExternalUrl({
 *   url: 'https://www.example.com',
 * });
 * ```
 *
 * @example Detect when a user navigates to the external URL
 * ```typescript
 * import { requestOpenExternalUrl } from '@canva/platform';
 *
 * const response = await requestOpenExternalUrl({
 *   url: 'https://www.example.com',
 * });
 *
 * if (response.status === 'completed') {
 *   // URL opened successfully
 * }
 * ```
 *
 * @example Detect when a user doesn't navigate to the external URL
 * ```typescript
 * import { requestOpenExternalUrl } from '@canva/platform';
 *
 * const response = await requestOpenExternalUrl({
 *   url: 'https://www.example.com',
 * });
 *
 * if (response.status === 'aborted') {
 *   // User declined to open URL
 * }
 * ```
 */
export declare const requestOpenExternalUrl: (request: OpenExternalUrlRequest) => Promise<OpenExternalUrlResponse>;

/**
 * @public
 * The result when a toast notification is successfully added.
 */
export declare type ToastCompleted = {
    /**
     * The status of the request.
     */
    status: 'completed';
};

/**
 * @public
 *
 * Options for configuring a toast notification.
 */
export declare type ToastRequest = {
    /**
     * Text to show within the toast notification.
     */
    messageText: string;
    /**
     * The duration that the notification will be visible.
     *
     * If set to `"infinite"`, the notification will be displayed until manually dismissed by the user.
     *
     * If set to a number, the notification will automatically disappear after that duration (in milliseconds).
     *
     * @defaultValue 5000
     */
    timeoutMs?: number | 'infinite';
};

/**
 * @public
 *
 * The response from adding a toast notification.
 */
export declare type ToastResponse = ToastCompleted;

export { }
