package main

import (
	"net/url"
	"strings"
)

// EncodeArgs encodes the arguments in the command using URL encoding
func EncodeArgs(command string) string {
	parts := strings.SplitN(command, " ", 2)
	if len(parts) < 2 {
		return command
	}

	cmd := parts[0]
	args := parts[1]
	encodedArgs, _ := url.QueryUnescape(args)
	return cmd + " " + encodedArgs
}

func DecodeArgs(command string) []string {
	parts := strings.Split(command, " ")
	var decodedParts []string
	inQuote := false
	var quotedArg strings.Builder
	quoteChar := ""

	for _, part := range parts {
		if !inQuote && (strings.HasPrefix(part, "\"") || strings.HasPrefix(part, "'")) {
			// Detect starting quote.
			inQuote = true
			quoteChar = string(part[0])
			quotedPart := strings.TrimPrefix(part, quoteChar)
			if strings.HasSuffix(quotedPart, quoteChar) {
				// Single-word quoted argument.
				inQuote = false
				decodedPart, _ := url.QueryUnescape(strings.TrimSuffix(quotedPart, quoteChar))
				decodedParts = append(decodedParts, decodedPart)
				quoteChar = ""
			} else {
				quotedArg.WriteString(quotedPart + " ")
			}
		} else if inQuote && strings.HasSuffix(part, quoteChar) {
			// Detect closing quote.
			inQuote = false
			quotedPart := strings.TrimSuffix(part, quoteChar)
			quotedArg.WriteString(quotedPart)
			decodedArg, _ := url.QueryUnescape(quotedArg.String())
			decodedParts = append(decodedParts, decodedArg)
			quotedArg.Reset()
			quoteChar = ""
		} else if inQuote {
			// Inside a quoted argument.
			quotedArg.WriteString(part + " ")
		} else {
			// Unquoted argument.
			decodedArg, _ := url.QueryUnescape(part)
			decodedParts = append(decodedParts, decodedArg)
		}
	}

	// Handle case where the last part is still in quotes
	if inQuote {
		// Remove the trailing space added in the loop.
		quotedArgStr := quotedArg.String()
		if len(quotedArgStr) > 0 && quotedArgStr[len(quotedArgStr)-1] == ' ' {
			quotedArgStr = quotedArgStr[:len(quotedArgStr)-1]
		}
		decodedArg, _ := url.QueryUnescape(quotedArgStr)
		decodedParts = append(decodedParts, decodedArg)
	}

	return decodedParts
}