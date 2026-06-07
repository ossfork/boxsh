#pragma once

#include <cstddef>
#include <string>

namespace boxsh {

bool write_all(int fd, const void *buf, size_t len);
bool read_all(int fd, void *buf, size_t len);

// Replace invalid UTF-8 byte sequences with the Unicode replacement
// character (U+FFFD = 0xEF 0xBF 0xBD). Returns a valid-UTF-8 string.
std::string ensure_valid_utf8(const std::string &s);

} // namespace boxsh