# deepseek-harness plugins with customizations

To import a plugin:

```
sl subtree import --url https://github.com/USER/NAME.git --to-path NAME -r MAIN
```

## Source & build

All plugins are shipped source-ready — importing / installing them needs **no extra build step**:

- **dsh-bill**: `lib/` **is** the source. There is no `src/ → lib/` build; edit `lib/` directly.
- **dsh-web-notification**: has a `src/ → lib/` build (`npm run build` / `node build.mjs`), but the generated `lib/` is **already checked in** and kept in sync with `src/`. Edits go to `src/`; after editing, re-run the build and commit both `src/` and `lib/`.

The importable artifacts (`main` / `exports` → `lib/...`) are always present in the repository, so consumers can use them directly without building.
