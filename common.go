package main

import "strings"

// guessLanguage suggests the best printing method for a printer based on its
// queue name and driver name. The user can always override it in the UI.
func guessLanguage(name, driver string) (brand, lang string) {
	s := strings.ToLower(name + " " + driver)
	has := func(keys ...string) bool {
		for _, k := range keys {
			if strings.Contains(s, k) {
				return true
			}
		}
		return false
	}
	switch {
	case has("lp 2844", "lp2844", "tlp 2844", "tlp2844", "lp 2824", "tlp 2824", "eltron", "epl"):
		return "Zebra / Eltron (EPL)", "epl"
	case has("zdesigner", "zebra", "gk420", "gx420", "gc420", "zd410", "zd420", "zd421", "zd220", "zd230", "zd620", "zt2", "zt4", "zpl"):
		return "Zebra", "zpl"
	case has("tsc ", "tsc_", "tsc-", "ttp-", "te200", "te210", "te300", "da200", "da210", "tspl"):
		return "TSC", "tspl"
	case has("xprinter", "xp-4", "xp-3", "xp-d", "munbyn", "idprt", "hprt", "itpp", "beeprt", "polono", "jadens", "nelko", "mfltech"):
		return "TSPL compatible", "tspl"
	case has("dymo"):
		return "Dymo", "driver"
	case has("brother", "ql-", "td-4", "td-2"):
		return "Brother", "driver"
	case has("rollo"):
		return "Rollo", "driver"
	case has("honeywell", "intermec", "datamax", "godex", "sato", "citizen", "bixolon", "toshiba", "argox"):
		return "Label printer", "driver"
	}
	return "", "driver"
}
