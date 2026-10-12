//! The Windows/Linux application menu - `Help > About EasyClip`.
//!
//! macOS never reaches this: `Builder::build()` installs `Menu::default()` itself when
//! no menu is set (`tauri-2.11.5/src/app.rs:2245`, gated `#[cfg(target_os = "macos")]`),
//! and calling `.menu()` there would REPLACE the whole app menu, losing About/Services/
//! Hide/Quit. That auto-install is macOS-only, which is why Windows and Linux have no
//! menu - and so no version anywhere - today.
//!
//! The metadata is hand-built rather than taken from `Menu::default()` for two reasons:
//!
//! 1. `Menu::default()` sources copyright/authors from `config.bundle.{copyright,publisher}`,
//!    and `tauri-utils`' `impl ToTokens for BundleConfig` emits `quote!(None)` for both
//!    unconditionally (`tauri-utils-2.9.3/src/config.rs:4024,4031`) - so they are `None`
//!    in the binary no matter what `tauri.conf.json` says. Runtime values must come from
//!    Rust; the JSON copy reaches the bundler only - which is how macOS's native About
//!    panel still shows a copyright, by way of Info.plist rather than Tauri's config.
//! 2. `Menu::default()`'s File and Window submenus hold only predefined items that muda's
//!    GTK backend silently drops (`is_item_supported!` accepts just Separator/Copy/Cut/
//!    Paste/SelectAll/About), so on Linux it draws EMPTY "File" and "Window" menus.

use tauri::menu::AboutMetadata;

/// Copyright line for the About dialog on Windows and Linux.
///
/// Duplicated from `LICENSE` on purpose: Tauri's `bundle.copyright` is nulled by codegen
/// and unreachable at runtime (see the module docs). macOS never reads this const - its
/// About panel is Cocoa's standard one, which reads `NSHumanReadableCopyright` out of
/// Info.plist, and the bundler writes that from the same `bundle.copyright` key. So one
/// release carries two copyright sources; `tests/about_menu.rs` pins this const to
/// `LICENSE` AND to `tauri.conf.json` so neither copy can drift from the other.
pub const COPYRIGHT: &str = "Copyright (c) 2026 lifebugz";

/// `Some(trimmed)` for real content, `None` for blank.
///
/// Both backends render a field's LABEL whenever it is `Some`, so `Some("")` becomes a
/// dangling `Authors: ` with nothing after it. Normalising here keeps a missing value
/// degrading to one fewer line rather than one broken line.
fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// The exact metadata handed to `PredefinedMenuItem::about`.
///
/// Pure - no menu, no windowing, no main thread. This is why the dialog's *content* is
/// testable in `cargo test` on every platform, including macOS, where `help_menu` below is
/// not compiled at all.
///
/// Contract (pinned by the tests in this file and in `tests/about_menu.rs`):
///
/// * `name` / `version` - `non_empty` of the argument, so blank degrades to an absent
///   line rather than a dangling label.
/// * `copyright` - always [`COPYRIGHT`].
/// * `authors` - `authors` is `CARGO_PKG_AUTHORS`, which Cargo joins with `':'`. Split on
///   it, `non_empty` each part, and drop the blanks. An all-blank input must yield `None`,
///   NOT `Some(vec![])` - an empty `Vec` is still `Some`, so it renders the dangling label.
/// * every other field - left at `Default::default()`.
pub fn about_metadata(name: &str, version: &str, authors: &str) -> AboutMetadata<'static> {
    let authors: Vec<String> = authors.split(':').filter_map(non_empty).collect();
    AboutMetadata {
        name: non_empty(name),
        version: non_empty(version),
        authors: (!authors.is_empty()).then_some(authors),
        copyright: Some(COPYRIGHT.to_owned()),
        ..Default::default()
    }
}

/// muda's default label for the About item is a bare `&About`
/// (`muda-0.19.1/src/items/predefined.rs`); name the product instead.
///
/// `&` is the Win32 mnemonic marker - it underlines the next character under Alt. muda
/// rewrites it to GTK's `_` on Linux (`to_gtk_mnemonic`), so one spelling covers both.
pub fn about_item_label(product_name: &str) -> String {
    format!("&About {product_name}")
}

/// Builds the one-submenu menu bar installed on Windows and Linux.
///
/// Generic over `R` rather than concrete `Wry` so the shim stays honest about what it
/// actually needs from the runtime.
#[cfg(all(desktop, not(target_os = "macos")))]
pub fn help_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

    // name/version come from tauri.conf.json's productName/version via codegen; authors
    // is env!("CARGO_PKG_AUTHORS"), i.e. src-tauri/Cargo.toml.
    let pkg = app.package_info();
    let label = about_item_label(&pkg.name);
    let about = PredefinedMenuItem::about(
        app,
        Some(label.as_str()),
        Some(about_metadata(
            &pkg.name,
            &pkg.version.to_string(),
            pkg.authors,
        )),
    )?;

    let help = Submenu::with_items(app, "&Help", true, &[&about])?;
    Menu::with_items(app, &[&help])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_keeps_real_content_and_trims_it() {
        assert_eq!(non_empty("lifebugz"), Some("lifebugz".to_owned()));
        assert_eq!(non_empty("  lifebugz  "), Some("lifebugz".to_owned()));
    }

    #[test]
    fn non_empty_rejects_blank() {
        // Some("") would render a dangling "Authors: " with nothing after it.
        assert_eq!(non_empty(""), None);
        assert_eq!(non_empty("   \t \n "), None);
    }

    #[test]
    fn splits_cargo_colon_joined_authors() {
        let meta = about_metadata("EasyClip", "0.3.0", "lifebugz:Someone Else");
        assert_eq!(
            meta.authors,
            Some(vec!["lifebugz".to_owned(), "Someone Else".to_owned()])
        );
    }

    #[test]
    fn single_author_is_one_entry() {
        let meta = about_metadata("EasyClip", "0.3.0", "lifebugz");
        assert_eq!(meta.authors, Some(vec!["lifebugz".to_owned()]));
    }

    #[test]
    fn blank_authors_are_absent_not_empty() {
        // Some(vec![]) is still Some, so it renders the label with nothing after it.
        for blank in ["", "   ", ":", " : : "] {
            assert_eq!(
                about_metadata("EasyClip", "0.3.0", blank).authors,
                None,
                "blank authors {blank:?} must be absent, not an empty Vec"
            );
        }
    }

    #[test]
    fn blank_name_and_version_are_absent() {
        let meta = about_metadata("", "  ", "lifebugz");
        assert_eq!(meta.name, None);
        assert_eq!(meta.version, None);
    }

    #[test]
    fn carries_the_copyright_and_nothing_else() {
        let meta = about_metadata("EasyClip", "0.3.0", "lifebugz");
        assert_eq!(meta.name, Some("EasyClip".to_owned()));
        assert_eq!(meta.version, Some("0.3.0".to_owned()));
        assert_eq!(meta.copyright, Some(COPYRIGHT.to_owned()));
        // Fields left at Default - a stray Some() here is a label with no content.
        assert_eq!(meta.short_version, None);
        assert_eq!(meta.comments, None);
        assert_eq!(meta.license, None);
        assert_eq!(meta.website, None);
        assert_eq!(meta.website_label, None);
        assert_eq!(meta.credits, None);
    }

    #[test]
    fn about_label_names_the_product_with_a_mnemonic() {
        assert_eq!(about_item_label("EasyClip"), "&About EasyClip");
    }
}
