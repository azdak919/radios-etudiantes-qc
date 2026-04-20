# Visual Foundation Upgrade PR

## Description
Upgrade visual foundation and standardize UI with the following changes:

- Added global CSS variables (design tokens) for colors, spacing, radius, shadow, and font size in :root.
- Standardized layout/grid, improved responsive behavior for desktop/mobile/tablet.
- Unified all core cards (.news-card, .schedule-card), glass panels, and button styles to consistently use tokens for radius, shadow, spacing, hover, and active states.
- Applied a modular typography scale for headings, body, and UI text.
- Cleaned up box-sizing, spacing, and focus-visible outline for accessibility.
- Upgraded main containers (main, grid) for clearer hierarchy and improved section gaps.
- Added standardized empty state styling.
- No breaking changes—no APIs/routes/features/logic touched.

## Impact
This PR sets up your app for a polished, modern look and is future-ready for theming (CSS variables), improved accessibility, and easy further extension.

**Date and Time (UTC): 2026-04-20 22:25:27**
**User:** azdak919