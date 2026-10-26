// The scrubber is contracts', so the shells' speech process scrubs with the same one;
// every server log and copy still goes through it from here.
export { CENSOR, redactSecrets, redactText } from "@gram/contracts";
