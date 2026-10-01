package com.crossroads.player;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.IOException;
import java.security.InvalidKeyException;
import java.security.ProviderException;
import java.security.UnrecoverableKeyException;

import javax.crypto.AEADBadTagException;
import javax.crypto.IllegalBlockSizeException;

/**
 * JVM test of the error classification only (the Keystore itself needs a device). The
 * Android-only exception types cannot be instantiated against the stub android.jar, so the
 * API 33+ KeyStoreException branch is covered by review, not here.
 */
public class SecretStoreTest {

    @Test
    public void onlyProvablyUnrecoverableErrorsArePermanent() {
        assertTrue(SecretStore.isPermanent(new AEADBadTagException("tag mismatch")));
        // wrapped: the JCA layer may wrap the provider's exception; the cause chain is walked
        assertTrue(SecretStore.isPermanent(new RuntimeException("wrapped", new AEADBadTagException("tag"))));
        assertTrue(SecretStore.isPermanent(new ProviderException("x", new InvalidKeyException("y", new AEADBadTagException("z")))));
        assertFalse(SecretStore.isPermanent(new IllegalBlockSizeException("no tag involved")));
    }

    @Test
    public void plainKeyErrorsAndUnknownsAreTransient() {
        // a plain InvalidKeyException says nothing about whether the key is gone (P1)
        assertFalse(SecretStore.isPermanent(new InvalidKeyException("Keystore operation failed")));
        assertFalse(SecretStore.isPermanent(new InvalidKeyException("x", new RuntimeException("daemon busy"))));
        assertFalse(SecretStore.isPermanent(new UnrecoverableKeyException("Failed to obtain information about key")));
        assertFalse(SecretStore.isPermanent(new ProviderException("Keystore operation failed")));
        assertFalse(SecretStore.isPermanent(new IOException("timeout")));
        assertFalse(SecretStore.isPermanent(new IllegalStateException("Cipher not initialized")));
        assertFalse(SecretStore.isPermanent(new IllegalArgumentException("not from the blob")));
        assertFalse(SecretStore.isPermanent(new RuntimeException("x", new InvalidKeyException("y"))));
        assertFalse(SecretStore.isPermanent(new OutOfMemoryError()));
        assertFalse(SecretStore.isPermanent(null));
    }
}
