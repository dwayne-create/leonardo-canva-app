# CHANGELOG

## 2.2.2 - 2026-02-16

### Fixed

- Fixed a duplicate declaration error caused by scope hoisting

## 2.2.1 - 2026-01-19

### Added

- Added a CHANGELOG.md to track changes.

## 2.2.0 - 2025-06-25

### Added

- Added the `notification.addToast` method from the [Notification API](https://www.canva.dev/docs/apps/api/latest/platform-notification-add-toast/) which allows apps to display lightweight toast messages in the Canva editor.

## 2.1.0 - 2024-12-15

### Added

- Introduced a test harness to allow for [unit testing](https://www.canva.dev/docs/apps/testing/) of the package.

## 2.0.0 - 2024-09-19

### Changed

- **Breaking:** See [Apps SDK Migration Guide](https://www.canva.dev/docs/apps/upgrades-and-migrations/v2-migration-guide/) for full list of changes.

## 1.1.0 - 2024-05-06

### Added

- Added [appProcess](https://www.canva.dev/docs/apps/api/platform-app-process/) under `@canva/platform` which was previously in beta (moved from preview to stable).

## 1.0.1 - 2023-12-12

### Added

- Introduced `@canva/platform` package which contains the [requestOpenExternalUrl](https://www.canva.dev/docs/apps/api/platform-request-open-external-url) and [getPlatformInfo](https://www.canva.dev/docs/apps/api/platform-get-platform-info/) methods.
