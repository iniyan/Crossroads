package com.crossroads.player;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LanAddressTest {

    @Test
    public void acceptsPrivateIpv4Literals() {
        for (String host : new String[] { "10.0.2.2", "10.255.255.255", "172.16.0.1", "172.31.9.9", "192.168.0.107", "169.254.10.1" }) {
            assertTrue(host, LanAddress.isPrivateLiteral(host));
        }
    }

    @Test
    public void rejectsPublicLoopbackAndNames() {
        for (String host : new String[] { "8.8.8.8", "127.0.0.1", "172.32.0.1", "172.15.255.255", "100.64.0.1", "192.169.1.1", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01a.1.1.1", "localhost", "desktop.local", "", "192.168.1.1.", "2001:db8::1", "::1" }) {
            assertFalse(host, LanAddress.isPrivateLiteral(host));
        }
        assertFalse(LanAddress.isPrivateLiteral(null));
    }

    @Test
    public void acceptsIpv6LinkLocalAndUniqueLocalWithoutZone() {
        assertTrue(LanAddress.isPrivateLiteral("fe80::1"));
        assertTrue(LanAddress.isPrivateLiteral("FE80:0:0:0:0:0:0:1"));
        assertTrue(LanAddress.isPrivateLiteral("fd12:3456::1"));
        assertTrue(LanAddress.isPrivateLiteral("fc00::abcd"));
        assertFalse(LanAddress.isPrivateLiteral("fe80::1%wlan0"));
        assertFalse(LanAddress.isPrivateLiteral("febf::1:2:3:4:5:6:7:8"));
        assertFalse(LanAddress.isPrivateLiteral("fec0::1"));
        assertFalse(LanAddress.isPrivateLiteral("::ffff:192.168.1.1"));
        assertFalse(LanAddress.isPrivateLiteral("fe80:::1"));
        assertFalse(LanAddress.isPrivateLiteral("fe80::1::2"));
        assertFalse(LanAddress.isPrivateLiteral("fe80::12345"));
    }

    @Test
    public void parsesIpv6Groups() {
        assertArrayEquals(new int[] { 0xfe80, 0, 0, 0, 0, 0, 0, 1 }, LanAddress.parseIpv6("fe80::1"));
        assertArrayEquals(new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }, LanAddress.parseIpv6("1:2:3:4:5:6:7:8"));
        assertArrayEquals(new int[] { 0, 0, 0, 0, 0, 0, 0, 0 }, LanAddress.parseIpv6("::"));
        assertNull(LanAddress.parseIpv6("1:2:3:4:5:6:7"));
        assertNull(LanAddress.parseIpv6("1:2:3:4:5:6:7:8:9"));
        assertNull(LanAddress.parseIpv6("g::1"));
    }

    @Test
    public void parsesOnlyHttpToPrivateHostsUnderV1() {
        LanAddress.Target t = LanAddress.parse("http://192.168.0.107:51234/v1/sync");
        assertNotNull(t);
        assertEquals("192.168.0.107", t.host);
        assertEquals(51234, t.port);
        assertEquals("/v1/sync", t.pathAndQuery);
        LanAddress.Target status = LanAddress.parse("http://10.0.2.2:8080/v1/pair/status?session=abc-123");
        assertNotNull(status);
        assertEquals("10.0.2.2", status.host);
        assertEquals("/v1/pair/status?session=abc-123", status.pathAndQuery);
        assertTrue(LanAddress.isIpLiteral("127.0.0.1"));
        assertTrue(LanAddress.isIpLiteral("8.8.8.8"));
        assertTrue(LanAddress.isIpLiteral("::1"));
        assertFalse(LanAddress.isIpLiteral("localhost"));
        assertFalse(LanAddress.isIpLiteral("desktop.local"));
        LanAddress.Target v6 = LanAddress.parse("http://[fd00::5]:9000/v1/info");
        assertNotNull(v6);
        assertEquals("fd00::5", v6.host);

        for (String url : new String[] {
            "https://192.168.0.107:51234/v1/sync",       // only plain http (app-layer encrypted)
            "http://192.168.0.107/v1/sync",              // port required
            "http://192.168.0.107:0/v1/sync",
            "http://192.168.0.107:70000/v1/sync",
            "http://8.8.8.8:80/v1/sync",
            "http://desktop.local:51234/v1/sync",         // no names
            "http://192.168.0.107:51234/v2/sync",
            "http://192.168.0.107:51234/",
            "http://192.168.0.107:51234/v1/../etc",
            "http://192.168.0.107:51234/v1//sync",
            "http://user:pw@192.168.0.107:51234/v1/sync",
            "http://192.168.0.107:51234/v1/sync#frag",
            "http://[fe80::1%25wlan0]:51234/v1/sync",
            "ftp://192.168.0.107:21/v1/sync",
            "not a url",
            "",
            null
        }) {
            assertNull(String.valueOf(url), LanAddress.parse(url));
        }
    }
}
