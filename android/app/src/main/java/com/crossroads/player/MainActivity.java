package com.crossroads.player;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaLibraryPlugin.class);
        registerPlugin(MediaSessionPlugin.class);
        registerPlugin(MediaFilesPlugin.class);
        registerPlugin(ImageExportPlugin.class);
        registerPlugin(SyncDiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
        // Capacitor's local server mishandles Range requests (206 but streamed from byte 0),
        // which breaks seeking in the audio element; serve ranges for local files ourselves.
        bridge.setWebViewClient(new RangeAwareWebViewClient(bridge));
    }
}
