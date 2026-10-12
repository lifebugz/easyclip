//! Guards the content of the `Help > About EasyClip` dialog shipped on Windows and Linux.
//!
//! That dialog is EasyClip's only version display, and it is invisible to every other
//! gate: Playwright drives the webview, the WDIO spike is macOS-only, and the native menu
//! exists only on the two platforms neither can reach. Nothing renders it in CI either.
//!
//! What CI *can* do is run this file - the "Layer 1 (cargo test)" step carries no `if:`,
//! so it executes on all three legs of the matrix. So this pins the data the dialog is
//! built from, using the very same `about_metadata()` the app calls, against the real
//! `tauri.conf.json` and `LICENSE` embedded at compile time (`include_str!`, so there is
//! no runtime file IO and the paths resolve relative to THIS file).

use easyclip_lib::menu::{about_item_label, about_metadata, COPYRIGHT};

const CONFIG: &str = include_str!("../tauri.conf.json");
const LICENSE: &str = include_str!("../../LICENSE");

/// `productName` and `version` are the two config fields that DO survive codegen as
/// literals (`tauri-codegen-2.6.3/src/context.rs`), so they are what the running binary's
/// `PackageInfo` actually reports.
fn product_name_and_version() -> (String, String) {
    let conf: serde_json::Value =
        serde_json::from_str(CONFIG).expect("tauri.conf.json is valid JSON");
    let name = conf["productName"]
        .as_str()
        .expect("productName is a string")
        .to_owned();
    let version = conf["version"]
        .as_str()
        .expect("version is a string")
        .to_owned();
    (name, version)
}

/// Same env var the app passes in: `PackageInfo::authors` is `env!("CARGO_PKG_AUTHORS")`,
/// and this test crate is built from the same package, so it resolves identically.
const AUTHORS: &str = env!("CARGO_PKG_AUTHORS");

/// Without this, a config restructure would make `product_name_and_version()` panic -
/// or, worse, a schema change could leave every assertion below comparing `None` to
/// `None` and passing vacuously. Same guard as `asset_scope.rs`.
#[test]
fn config_and_license_inputs_actually_parse() {
    let (name, version) = product_name_and_version();
    assert!(!name.is_empty(), "productName parsed as empty");
    assert!(
        version.split('.').count() >= 2,
        "version {version:?} does not look like a semver the About dialog can show"
    );
    assert!(
        !AUTHORS.trim().is_empty(),
        "CARGO_PKG_AUTHORS is empty - the Authors line would silently vanish"
    );
    assert!(
        LICENSE.lines().count() > 10,
        "LICENSE did not embed; the copyright assertion below would be vacuous"
    );
    // LICENSE contains blank lines, so a blanked COPYRIGHT would match one of them and
    // make `copyright_matches_the_license_file_verbatim` pass while asserting nothing.
    assert!(
        !COPYRIGHT.trim().is_empty(),
        "COPYRIGHT is blank; the LICENSE match below would succeed against a blank line"
    );
}

#[test]
fn about_dialog_shows_the_shipped_product_name_and_version() {
    let (name, version) = product_name_and_version();
    let meta = about_metadata(&name, &version, AUTHORS);
    assert_eq!(meta.name.as_deref(), Some(name.as_str()));
    assert_eq!(meta.version.as_deref(), Some(version.as_str()));
}

#[test]
fn no_about_field_is_present_but_blank() {
    let (name, version) = product_name_and_version();
    let meta = about_metadata(&name, &version, AUTHORS);

    // Both backends render a field's LABEL whenever it is Some, so a Some("") ships a
    // dangling "Authors: " with nothing after it.
    for (field, value) in [
        ("name", &meta.name),
        ("version", &meta.version),
        ("short_version", &meta.short_version),
        ("comments", &meta.comments),
        ("copyright", &meta.copyright),
        ("license", &meta.license),
        ("website", &meta.website),
        ("website_label", &meta.website_label),
        ("credits", &meta.credits),
    ] {
        if let Some(text) = value {
            assert!(
                !text.trim().is_empty(),
                "{field} is Some but blank - renders a label with no content"
            );
        }
    }

    match &meta.authors {
        // Some(vec![]) is still Some: the label renders, the names do not.
        Some(authors) => {
            assert!(!authors.is_empty(), "authors is Some but empty");
            for author in authors {
                assert!(!author.trim().is_empty(), "blank entry among {authors:?}");
            }
        }
        None => panic!("Cargo.toml declares authors, so the dialog must list them"),
    }
}

#[test]
fn copyright_matches_the_license_file_verbatim() {
    assert!(
        LICENSE.lines().any(|line| line.trim() == COPYRIGHT),
        "menu::COPYRIGHT ({COPYRIGHT:?}) is not a line in LICENSE - the hand-copy rotted"
    );
}

/// The two copyright sources one release ships with must agree.
///
/// Windows/Linux render `menu::COPYRIGHT`; macOS renders Info.plist's
/// `NSHumanReadableCopyright`, which the bundler writes from `bundle.copyright`. Tauri's
/// codegen nulls `bundle.copyright` for the runtime, so neither can substitute for the
/// other - edit one and the same release shows two different copyrights depending on the
/// platform. Confirmed by UAT: planting a sentinel in Info.plist changed the macOS panel
/// verbatim, so that key really is what macOS displays.
#[test]
fn config_copyright_matches_the_rust_constant() {
    let conf: serde_json::Value =
        serde_json::from_str(CONFIG).expect("tauri.conf.json is valid JSON");
    let bundled = conf["bundle"]["copyright"]
        .as_str()
        .expect("bundle.copyright is a string - macOS reads it via Info.plist");
    assert_eq!(
        bundled, COPYRIGHT,
        "bundle.copyright (macOS About panel) and menu::COPYRIGHT (Windows/Linux) drifted"
    );
}

#[test]
fn about_item_is_labelled_with_the_product_name() {
    let (name, _) = product_name_and_version();
    let label = about_item_label(&name);
    assert!(
        label.contains(&name),
        "About item {label:?} must name the product, not muda's bare \"&About\""
    );
    // `&` is the Win32 mnemonic marker: it is consumed and underlines the NEXT character.
    // One in productName would eat a letter out of the visible title.
    assert!(
        !name.contains('&'),
        "productName {name:?} contains '&', which Windows would swallow as a mnemonic"
    );
    assert_eq!(
        label.matches('&').count(),
        1,
        "exactly one mnemonic marker expected in {label:?}"
    );
}
