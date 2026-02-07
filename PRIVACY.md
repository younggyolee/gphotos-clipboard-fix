# Privacy Policy — Google Photos Clipboard Fix

*Last updated: February 7, 2026*

## Overview

Google Photos Clipboard Fix is a browser extension that copies images from Google Photos as real image data so they paste correctly into blog editors and other apps. This privacy policy describes how the extension handles data.

## Data Collection

This extension does **not** collect, store, transmit, or share any user data. Specifically, we do not collect:

- Personal information
- Browsing history
- Analytics or usage data
- Cookies or tracking identifiers

## How the Extension Works

When you right-click an image on Google Photos and select "Copy image for pasting," the extension:

1. Reads the image pixel data from the current page
2. Converts it to PNG format
3. Writes it to your clipboard

All processing happens **locally in your browser**. No data is sent to any external server, third party, or remote service. Image data is held temporarily in memory only for the duration of the clipboard operation.

## Permissions

The extension requires certain browser permissions solely to perform its core function:

- **clipboardWrite** — to place copied image data on your clipboard
- **activeTab** — to access image elements on the active Google Photos tab
- **contextMenus** — to add the "Copy image for pasting" right-click menu item
- **Host access to Google domains** — to fetch full-resolution images from Google's image CDN when needed

## Third-Party Services

This extension does not use any third-party services, analytics, or tracking tools.

## Changes to This Policy

If this policy is updated, the changes will be posted here with a revised date.

## Contact

If you have questions about this privacy policy, please open an issue at: https://github.com/nicekid1/GPhotos-Clipboard-Fix/issues
