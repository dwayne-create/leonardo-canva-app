# @canva/design

A package for Canva's Apps SDK that provides methods for interacting with a user's design.

![](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)

## Table of contents

- [Introduction](#introduction)
- [Installation](#installation)
- [Usage](#usage)
- [API reference](#api-reference)
- [Related packages](#related-packages)
- [Contributing](#contributing)
- [License](#license)

## Introduction

`@canva/design` is an npm package for Canva's [Apps SDK](https://www.canva.dev/docs/apps). It provides methods for interacting with a user's design. For example, the `addPage` method adds a page to the user's design, while `requestExport` exports the user's design as one or more static files.

**Note:** To get up and running with the Apps SDK, check out [the quick start guide](https://www.canva.dev/docs/apps/quick-start).

## Installation

```bash
npm install @canva/design
```

## Usage

1. Import a method or namespace from the `@canva/design` package:

   ```ts
   import { addPage } from '@canva/design';
   ```

2. Call a method, passing in the required arguments (if any):

   ```ts
   await addPage();
   ```

## API reference

- [`addAudioTrack`](https://www.canva.dev/docs/apps/api/design-add-audio-track)
- [`addElementAtPoint`](https://www.canva.dev/docs/apps/api/design-add-element-at-point)
- [`addPage`](https://www.canva.dev/docs/apps/api/design-add-page)
- [`editContent`](https://www.canva.dev/docs/apps/api/design-edit-content)
- [`getCurrentPageContext`](https://www.canva.dev/docs/apps/api/design-get-current-page-context)
- [`getDefaultPageDimensions`](https://www.canva.dev/docs/apps/api/design-get-default-page-dimensions)
- [`initAppElement`](https://www.canva.dev/docs/apps/api/design-init-app-element)
- [`openDesign`](https://www.canva.dev/docs/apps/api/design-open-design)
- [`requestExport`](https://www.canva.dev/docs/apps/api/design-request-export)
- [`selection.registerOnChange`](https://www.canva.dev/docs/apps/api/design-selection-register-on-change)
- [`setCurrentPageBackground`](https://www.canva.dev/docs/apps/api/design-set-current-page-background)
- [`ui.startDrag`](https://www.canva.dev/docs/apps/api/design-ui-start-drag)

## Related packages

The Apps SDK is made up of the following packages:

- [`@canva/app-ui-kit`](https://www.npmjs.com/package/@canva/app-ui-kit) - React-based component library for creating apps that mimic the look and feel of Canva.
- [`@canva/asset`](https://www.npmjs.com/package/@canva/asset) - Provides methods for working with assets, such as image and video files.
- [`@canva/design`](https://www.npmjs.com/package/@canva/design) - Provides methods for interacting with the user's design, such as creating elements.
- [`@canva/error`](https://www.npmjs.com/package/@canva/error) - Provides a `CanvaError` class for handling errors.
- [`@canva/platform`](https://www.npmjs.com/package/@canva/platform) - Provides utility methods, such as a method for opening external links.
- [`@canva/user`](https://www.npmjs.com/package/@canva/user) - Provides methods for accessing user data and authenticating users.

## Contributing

We're actively developing this package but are not currently accepting third-party contributions. If you'd like to request any changes or additions to the package, submit a feature request via the [Canva Developers Community](https://community.canva.dev/).

## License

See the `LICENSE.md` file.
