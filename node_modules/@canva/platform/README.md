# @canva/platform

A package for Canva's Apps SDK that provides utility methods.

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

`@canva/platform` is an npm package for Canva's [Apps SDK](https://www.canva.dev/docs/apps). It provides utility methods that are useful for a broad range of apps. For example, the `requestOpenExternalUrl` method opens an external web page.

**Note:** To get up and running with the Apps SDK, check out [the quick start guide](https://www.canva.dev/docs/apps/quick-start).

## Installation

```bash
npm install @canva/platform
```

## Usage

1. Import a method or namespace from the `@canva/platform` package:

   ```ts
   import { getPlatformInfo } from '@canva/platform';
   ```

2. Call a method, passing in the required arguments (if any):

   ```ts
   getPlatformInfo();
   ```

## API reference

- [`getPlatformInfo`](https://www.canva.dev/docs/apps/api/platform-get-platform-info)
- [`requestOpenExternalUrl`](https://www.canva.dev/docs/apps/api/platform-request-open-external-url)

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
