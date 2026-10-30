//! WebAssembly exports (a plain C ABI, so no wasm-bindgen tooling is needed).
//!
//! JS calls `alloc(len)`, writes UTF-8 request JSON there, calls
//! `solve(ptr, len)`, and gets back a pointer to an 8-byte header (output
//! pointer, output length, both u32 little-endian) followed by nothing else;
//! it reads the output, then frees both buffers with `dealloc`.

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::dangling().as_ptr();
    }
    // SAFETY: non-zero size, align 1.
    unsafe { raw_alloc(Layout::from_size_align(len, 1).expect("layout")) }
}

/// # Safety
/// `ptr` must come from `alloc(len)` and not be freed yet.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len != 0 {
        raw_dealloc(ptr, Layout::from_size_align(len, 1).expect("layout"));
    }
}

/// # Safety
/// `ptr..ptr+len` must be a readable buffer from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn solve(ptr: *const u8, len: usize) -> *mut u8 {
    let request = std::slice::from_raw_parts(ptr, len);
    let response = match std::str::from_utf8(request) {
        Ok(text) => crate::api::solve_json(text),
        Err(_) => r#"{"status":"failed","message":"Request is not UTF-8."}"#.to_owned(),
    };
    let bytes = response.into_bytes();
    let out = alloc(bytes.len());
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
    let header = alloc(8);
    std::ptr::copy_nonoverlapping((out as u32).to_le_bytes().as_ptr(), header, 4);
    std::ptr::copy_nonoverlapping(
        (bytes.len() as u32).to_le_bytes().as_ptr(),
        header.add(4),
        4,
    );
    header
}
