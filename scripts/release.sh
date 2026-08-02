#!/usr/bin/env bash
# Release pipeline: build -> zip -> GitHub release -> update Homebrew tap.
#
# Usage: scripts/release.sh
#   The released version is taken from package.json. Bump it first, e.g.:
#   npm version patch --no-git-tag-version && git commit -am "Bump version"
#
# Requires: gh (authenticated), repos zoltanf/tranzl and zoltanf/homebrew-tap.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="zoltanf/tranzl"
TAP_REPO="zoltanf/homebrew-tap"

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
ZIP="dist/Tranzl-$VERSION-arm64.zip"

if gh release view "$TAG" --repo "$REPO" > /dev/null 2>&1; then
  echo "Release $TAG already exists on $REPO — bump the version in package.json first." >&2
  exit 1
fi

echo "==> Building Tranzl $VERSION"
npm run pack

echo "==> Zipping"
rm -f "$ZIP"
ditto -c -k --keepParent dist/Tranzl-darwin-arm64/Tranzl.app "$ZIP"
SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
echo "    sha256: $SHA"

echo "==> Creating GitHub release $TAG"
git push origin HEAD
gh release create "$TAG" "$ZIP" \
  --repo "$REPO" \
  --title "Tranzl $VERSION" \
  --notes "Tranzl $VERSION for Apple Silicon Macs.

Install/upgrade via Homebrew:
\`\`\`
brew install --cask zoltanf/tap/tranzl
\`\`\`"

echo "==> Updating Homebrew tap ($TAP_REPO)"
TAP_DIR=$(mktemp -d)
gh repo clone "$TAP_REPO" "$TAP_DIR" -- --depth 1
mkdir -p "$TAP_DIR/Casks"
cat > "$TAP_DIR/Casks/tranzl.rb" <<EOF
cask "tranzl" do
  version "$VERSION"
  sha256 "$SHA"

  url "https://github.com/$REPO/releases/download/v#{version}/Tranzl-#{version}-arm64.zip"
  name "Tranzl"
  desc "Private, on-device LLM translator and text editor"
  homepage "https://github.com/$REPO"

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Tranzl.app"

  # Tranzl is ad-hoc signed (not notarized); without this Gatekeeper refuses
  # to launch it. Disclosed in the caveats below.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Tranzl.app"]
  end

  zap trash: [
    "~/Library/Application Support/tranzl",
  ]

  caveats <<~EOS
    Tranzl is ad-hoc signed (not notarized). This cask removes the macOS
    quarantine attribute from the installed app so it can launch; only
    install it if you trust this tap.

    On first use, Tranzl offers to download the Gemma 4 E4B model (~4.6 GB),
    which is subject to Google's Gemma Terms of Use.
  EOS
end
EOF

git -C "$TAP_DIR" add Casks/tranzl.rb
git -C "$TAP_DIR" commit -m "tranzl $VERSION"
git -C "$TAP_DIR" push
rm -rf "$TAP_DIR"

echo "==> Done: Tranzl $VERSION released."
echo "    Users install with: brew install --cask zoltanf/tap/tranzl --no-quarantine"
