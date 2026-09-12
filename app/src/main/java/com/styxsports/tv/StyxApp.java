package com.styxsports.tv;

import android.app.Application;

public class StyxApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        CrashLog.install(this);
    }
}
