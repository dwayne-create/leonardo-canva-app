# CHANGELOG

## 2.3.0 - 2025-12-22

### Added

- Added optional `name` parameter to `ImageUploadOptions` and `VideoUploadOptions` for specifying a custom name for uploaded assets.

## 2.2.2 - 2025-12-18

### Changed

- Increase video size limit from 100MB to 1GB and increase audio size limit from 50MB to 250MB for uploading assets

## 2.2.1 - 2025-07-08

### Other

- Inline documentation improvements.

## 2.2.0 - 2025-04-01

### Added

- Added support for `video/x-msvideo` as an allowed MIME type

## 2.1.0 - 2024-12-15

### Added

- Introduced a test harness to allow for [unit testing](https://www.canva.dev/docs/apps/testing/) of the package.

## 2.0.0 - 2024-09-19

### Changed

- **Breaking:** See [Apps SDK Migration Guide](https://www.canva.dev/docs/apps/upgrades-and-migrations/v2-migration-guide/) for full list of changes.

## 1.7.1 - 2024-08-07

### Changed

- [asset.upload](https://www.canva.dev/docs/apps/api/asset-upload/#uploading-images) now allows larger image uploads (25 MB -> 50 MB).

## 1.7.0 - 2024-07-23

### Added

- Added [asset.openColorSelector](https://www.canva.dev/docs/apps/using-color-selectors) which was previously in beta.
- Added `selectedColor` prop to [asset.openColorSelector](https://www.canva.dev/docs/apps/using-color-selectors/#optional-step-5-handle-multiple-colors)

## 1.6.0 - 2024-06-20

### Added

- Added the ability to filter by `fontRefs` in [findFonts API](https://www.canva.dev/docs/apps/api/asset-find-fonts/#filtering).

## 1.5.0 - 2024-04-02

### Added

- Added support for `TIFF` in `upload`

## 1.4.0 - 2024-03-11

### Added

- The property `id` is now optional.

## 1.3.0 - 2024-02-25

### Added

- Added [getTemporaryUrl](https://www.canva.dev/docs/apps/api/asset-get-temporary-url/) to get URL of an asset, which was previously available in preview mode.
- Added [parentRef](https://www.canva.dev/docs/apps/api/asset-upload/#parameters) in `ImageUploadOptions` and `VideoUploadOptions` to a reference to the original asset, which was previously available in preview mode.
