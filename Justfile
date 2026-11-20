build:
    npm run build

# Build and install the plugin into an existing vault.
[no-cd]
[positional-arguments]
install path: build
    #!/usr/bin/env sh
    set -eu
    if [ ! -d "$1" ]; then
        printf 'Vault directory does not exist: %s\n' "$1" >&2
        exit 1
    fi
    source={{quote(justfile_directory() / 'dist/canvas-precomputed-lod')}}
    destination="$1/.obsidian/plugins/canvas-precomputed-lod"
    printf 'Installing plugin to %s\n' "$destination"
    mkdir -p -- "$destination"
    for file in main.js manifest.json styles.css LICENSE; do
        cp -- "$source/$file" "$destination/"
    done
    printf 'Installed Canvas Precomputed LOD in %s\n' "$destination"

lint:
    uv run pre-commit run --all-files

test:
    uv run python -m unittest discover -s tests -p 'test_*.py' -v
    uv run npm test

browser:
    uv run npm run test:browser

package: build
    uv run python scripts/package.py
