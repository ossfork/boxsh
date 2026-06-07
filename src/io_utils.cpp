#include "io_utils.h"

#include <cerrno>
#include <string>

#include <unistd.h>

namespace boxsh {

bool write_all(int fd, const void *buf, size_t len) {
    const char *ptr = static_cast<const char *>(buf);
    size_t written = 0;
    while (written < len) {
        ssize_t n = write(fd, ptr + written, len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;
        written += (size_t)n;
    }
    return true;
}

bool read_all(int fd, void *buf, size_t len) {
    char *ptr = static_cast<char *>(buf);
    size_t received = 0;
    while (received < len) {
        ssize_t n = read(fd, ptr + received, len - received);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;
        received += (size_t)n;
    }
    return true;
}

// ---------------------------------------------------------------------------
// UTF-8 validation / sanitization
// ---------------------------------------------------------------------------

// UTF-8 encoding rules:
//   0x00-0x7F            -> 1 byte
//   0xC2-0xDF            -> 2 bytes
//   0xE0-0xEF            -> 3 bytes
//   0xF0-0xF4            -> 4 bytes
//
// Invalid bytes / sequences are replaced with U+FFFD (U+FFFD = EF BF BD).

std::string ensure_valid_utf8(const std::string &s) {
    std::string out;
    out.reserve(s.size());

    const unsigned char *p = reinterpret_cast<const unsigned char *>(s.data());
    size_t len = s.size();
    size_t i = 0;

    while (i < len) {
        unsigned char c = p[i];

        // ASCII — always valid.
        if (c < 0x80) {
            out += (char)c;
            ++i;
            continue;
        }

        // Continuation byte or invalid lead byte — emit replacement char.
        if (c < 0xC2) {
            out += "\xEF\xBF\xBD";
            ++i;
            continue;
        }

        // Determine expected sequence length from lead byte.
        size_t seq_len = 0;
        if (c < 0xE0)       seq_len = 2;
        else if (c < 0xF0)  seq_len = 3;
        else if (c <= 0xF4) seq_len = 4;
        else {
            out += "\xEF\xBF\xBD";
            ++i;
            continue;
        }

        // Check that we have enough continuation bytes.
        if (i + seq_len > len) {
            out += "\xEF\xBF\xBD";
            ++i;
            continue;
        }

        // Verify each continuation byte.
        bool valid = true;
        for (size_t j = 1; j < seq_len; ++j) {
            if ((p[i + j] & 0xC0) != 0x80) {
                valid = false;
                break;
            }
        }

        if (valid) {
            // Additional checks for overlong / surrogate / out-of-range.
            if (seq_len == 2 && c < 0xC2) {
                valid = false; // overlong
            } else if (seq_len == 3) {
                if (c == 0xE0 && p[i + 1] < 0xA0)
                    valid = false; // overlong
                else if (c == 0xED && p[i + 1] >= 0xA0)
                    valid = false; // surrogate U+D800..U+DFFF
            } else if (seq_len == 4) {
                if (c == 0xF0 && p[i + 1] < 0x90)
                    valid = false; // overlong
                else if (c == 0xF4 && p[i + 1] > 0x8F)
                    valid = false; // > U+10FFFF
                else if (c > 0xF4)
                    valid = false;
            }
        }

        if (valid) {
            out.append(reinterpret_cast<const char *>(p + i), seq_len);
            i += seq_len;
        } else {
            out += "\xEF\xBF\xBD";
            ++i;
        }
    }

    return out;
}

} // namespace boxsh