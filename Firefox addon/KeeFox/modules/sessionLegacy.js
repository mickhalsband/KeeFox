/*
KeeFox - Allows Firefox to communicate with KeePass (via the KeePassRPC KeePass-plugin)
Copyright 2008-2013 Chris Tomlinson <keefox@christomlinson.name>

sessionLegacy.js manages the low-level transport connection between this
client and an KeePassRPC server. Functions in this file relate only to
connections to the old KPRPC protocol (< 1.3). They are still needed for the
foreseeable future to ensure smooth upgrades from earlier versions but
will be removed one day.

Some implementation ideas extended from code written by Shane
Caraveo, ActiveState Software Inc

Secure certificate exception code used under GPL2 license from:
MitM Me (Johnathan Nightingale)

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
*/
"use strict";

let Cc = Components.classes;
let Ci = Components.interfaces;
let Cu = Components.utils;

var EXPORTED_SYMBOLS = ["sessionLegacy"];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://kfmod/KFLogger.js");

var log = KFLog;

function sessionLegacy()
{
    this.transport = null;
    this.port = 12536;
    this.address = "127.0.0.1";
    this.connectLockLegacy = false;
}

sessionLegacy.prototype =
{
    certFailedReconnectTimer: null,
    
    connectLegacy: function()
    {
        try
        {
            if (this.transport != null && this.transport.isAlive())
                return "alive";
            if (this.connectLockLegacy)
                return "locked";
            this.connectLockLegacy = true;
            
            var transportService =
                Components.classes["@mozilla.org/network/socket-transport-service;1"].
                getService(Components.interfaces.nsISocketTransportService);
            var transport = transportService.createTransport(["ssl"], 1, this.address, this.port, null);
            //var transport = transportService.createTransport(null, 0, this.address, this.port, null);
            if (!transport) {
                this.onNotify("connect-failed", "Unable to create transport for "+this.address+":"+this.port); 
                log.warn("Problem connecting to KeePass: " + "Unable to create transport for "+this.address+":"+this.port);
                this.connectLockLegacy = false;
                return;
            }
            
            // we want to be told about security certificate problems so we can suppress them
            transport.securityCallbacks = this;
            //transport.connectionFlags = 1; //ANONYMOUS_CONNECT - no SSL client certs
            
            transport.setTimeout(Components.interfaces.nsISocketTransport.TIMEOUT_CONNECT, this.connectionTimeout);
            transport.setTimeout(Components.interfaces.nsISocketTransport.TIMEOUT_READ_WRITE, this.activityTimeout);
            this.setTransport(transport);
        } catch(ex)
        {
            this.onNotify("connect-failed", "Unable to connect to "+this.address+":"+this.port+"; Exception occured "+ex);
            log.warn("Problem connecting to KeePass: " + "Unable to connect to "+this.address+":"+this.port+"; Exception occured "+ex);
            this.disconnect();
        }
        this.connectLockLegacy = false;
    },
    
    //[deprecated]
    setTransport: function(transport)
    {
        try
        {
            this.transport = transport;
            this.raw_istream = this.transport.openInputStream(0, 512, 0);
            this.raw_ostream = this.transport.openOutputStream(0, 512, 0);            // change these all to 0 once seen if 512 causes more problems
            const replacementChar = Components.interfaces
                .nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER;
            var charset = "UTF-8";

            this.ostream = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
                               .createInstance(Components.interfaces.nsIConverterOutputStream);

            this.ostream.init(this.raw_ostream, charset, 0, replacementChar);

            this.istream = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
                               .createInstance(Components.interfaces.nsIConverterInputStream);
            this.istream.init(this.raw_istream, charset, 0, replacementChar);
            
            
            if (!this.transport.isAlive())
            {
                log.debug("transport stream is not alive yet");
                var mainThread = Components.classes["@mozilla.org/thread-manager;1"]
                                 .getService(Components.interfaces.nsIThreadManager).mainThread;
                var asyncOutputStream = this.raw_ostream.QueryInterface(Components.interfaces.nsIAsyncOutputStream);
                // We need to be able to write at least one byte.
                asyncOutputStream.asyncWait(this, 0, 1, mainThread);
                log.debug("async input wait begun.");
            } else
            {
                log.debug("transport stream is already alive");
                this.onConnect();
            }
        } catch (ex)
        {
            log.error("setTransport failed: " + ex);
            this.onNotify("connect-failed", "setTransport failed, Unable to connect; Exception " + ex);     
            this.disconnect(); 
        }
    },
    
    //[deprecated]
    onOutputStreamReady: function()
    {
        log.debug("onOutputStreamReady started");
    
        var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                     .getService(Components.interfaces.nsIWindowMediator);
        var window = wm.getMostRecentWindow("navigator:browser") ||
            wm.getMostRecentWindow("mail:3pane");

        var rpc = window.keefox_org.KeePassRPC;
            
        if (rpc.transport == undefined || rpc.transport == null)
        {
            log.error("Transport invalid!");    
        } else
        {
            log.debug("onConnectDelayTimerAction connected");
            rpc.onConnect();
        }
        log.debug("onOutputStreamReady ended");
    },
    
    //[deprecated]
    onConnect: function()
    {

      /*
       * This code was added in order to support Mono.
       *
       * What I found is that on the KeePassRPC side, when a client connects,
       * Mono does not continue executing until the client sends data to the server.
       * So I added this 'Idle' command that will be ignored by the server.
       * 
       * This seems like a mono bug to me. There is no rule that a client must
       * communicate first in a client/server relationship. Perhaps it has to
       * do with the connection being TLS/SSL3. That Mono code is not as well
       * developed as the other stuff.
       *
       * It should be okay to include this Idle command on both Mono and .NET,
       * but I don't want to take any chances of breaking .NET
       */
      var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                 .getService(Components.interfaces.nsIWindowMediator);
      var window = wm.getMostRecentWindow("navigator:browser") ||
            wm.getMostRecentWindow("mail:3pane");
      
      if (window.keefox_org.useMono)
      {
        try
        {
          log.debug("Session::onConnect - Sending Idle");
          var num_written = this.ostream.writeString('{"params":null,"method":"Idle","id":0}');
        } catch(ex) {
          log.error(ex, "Session::onConnect failed: ");
          this.onNotify("connect-failed", "Unable to connect; Exception occured "+ex);
          this.disconnect();
          return;
        }
      }
      
        try
        {
            log.debug("Setting up the async reading pump");
            // start the async read
            this.pump = Components.classes["@mozilla.org/network/input-stream-pump;1"]
                        .createInstance(Components.interfaces.nsIInputStreamPump);
            this.pump.init(this.raw_istream, -1, -1, 0, 0, false);
            this.pump.asyncRead(this, null);
        } catch(ex) {
            log.error(ex, "Session::onConnect failed: ");
            this.onNotify("connect-failed", "Unable to connect; Exception occured "+ex);
            this.disconnect(); 
        }
    },
    
    //[deprecated]
    disconnect: function()
    {
        log.info("Disconnecting from RPC server");
        if ("istream" in this && this.istream)
            this.istream.close();
        if ("ostream" in this && this.ostream)
            this.ostream.close();
        if ("raw_ostream" in this && this.raw_ostream)
            this.raw_ostream.close();
        if ("transport" in this && this.transport)
          this.transport.close(Components.results.NS_OK);
    
        this.pump = null;
        this.istream = null;
        this.ostream = null;
        this.raw_ostream = null;
        this.transport = null;
        this.onNotify("connect-closed", null);
    },

    //[deprecated]
    readData: function() 
    {
        var fullString = "";
        var str = {};
        while (this.istream.readString(4096, str) != 0)
            fullString += str.value;

        return fullString;
        //return this.istream.readBytes(count);
    },

    //[deprecated]
    writeData: function(data, dataLen)
    {
        try {
            if (!this.transport || !this.transport.isAlive()) {
                log.error("Session.transport is not available");
                //BUT: I think this does not necessarilly mean that the underlying
                // communication streams have been closed?! I think that this
                // transport refers only to the listener at the server end so this
                // will become "not alive" before the actual underlying TCP
                // connection between KF and KPRPC has been shutdown (or maybe
                // that will never even happen if there were a bug in the
                // listener socket code only).
                // Is there a different way to detect the closure of the
                // underlying streams maybe? In fact, maybe this should not even
                // be a reason to avoid writing to the ostream below?
                
                // With the forced disconnection commented out below, initial
                // tests are encouraging. Perhaps unexpected network dropouts
                // or 3rd party security software could cause new problems
                // but I think it's worth giving this change a wider trial.
                
                //this.disconnect();
                //this.connect();
                return -1;
            }
            if (arguments.length == 0) {
                log.debug("Session.writeData called with no args");
                return -1;
            } else if (arguments.length == 1) {
                dataLen = data.length;
            }
    
            var str1 = this.expand(data);
            //log.debug("writeData: [" + str1 + "]");
            
            var num_written = this.ostream.writeString(data);
            return num_written;
        } catch(ex) {
            log.debug("writeData failed: " + ex);
        }
        return -1;
    },

    //[deprecated]
    expand: function(s)
    {
        // JS doesn't have foo ||= val
        if (!this._hexEscape) {
            this._hexEscape = function(str) {
                var res1 = parseInt(str.charCodeAt(0)).toString(16);
                var leader = res1.length == 1 ? "0" : "";
                return "%" + leader + res1;
            };
        }
        return s.replace(/[\x00-\x09\x11-\x1f]/g, this._hexEscape);
    },

    // This is needed to allow us to get security certificate error notifications
    //[deprecated]
    getInterface: function (aIID) {
        return this.QueryInterface(aIID);
      },

    //[deprecated]
    handleFailedCertificate: function (gSSLStatus)
    {
        let gCert = gSSLStatus.QueryInterface(Components.interfaces.nsISSLStatus).serverCert;
          
        log.warn("Adding security certificate exception for " + this.address + ":" + this.port
            + " <-- This should be the address and port of the KeePassRPC server."
            + " If it is not localhost:12536 or 127.0.0.1:12536 and you have"
            + " not configured KeeFox to use alternative connection details"
            + " you should investigate this possible security problem, otherwise everything is probably OK."
            + " Note: The security certificate exception is required because KeePassRPC has"
            + " created a custom security certificate unique to your installation."
            + " This certificate is not authenticated by the organisations that Firefox"
            + " automatically trusts so an exception is required for this special case. "
            + "Please see the KeeFox website if you would like more information about this topic."
            );
            
        // Add the exception
        var overrideService = Components.classes["@mozilla.org/security/certoverride;1"]
                              .getService(Components.interfaces.nsICertOverrideService);
        var flags = 0;
        if(gSSLStatus.isUntrusted)
            flags |= overrideService.ERROR_UNTRUSTED;
        if(gSSLStatus.isDomainMismatch)
            flags |= overrideService.ERROR_MISMATCH;

        overrideService.rememberValidityOverride(this.address, this.port, gCert, flags, false);
        
        log.info("Exception added to Firefox");
        
        //Try to connect again immediately (well, after a tiny wait which should
        //be enough to ensure this failed attempt has given up before we try again)
        log.debug("Creating a reconnection timer.");
        this.certFailedReconnectTimer = Components.classes["@mozilla.org/timer;1"]
                    .createInstance(Components.interfaces.nsITimer);
         
        this.certFailedReconnectTimer.initWithCallback(this.reconnectNow,
            500,
            Components.interfaces.nsITimer.TYPE_ONE_SHOT); //TODO2: ?OK so far...? does the timer stay in scope?
        log.debug("Timer created.");
    },
    
    //[deprecated]
    notifyCertProblem: function MSR_notifyCertProblem(socketInfo, sslStatus, targetHost)
    {
        log.info("A security certification error was encountered while"
            + " negotiating the initial connection to KeePassRPC.");
        if (sslStatus)
            this.handleFailedCertificate(sslStatus);
        return true; // suppress error UI
    },
    
    // Shutdown this session, releasing all resources
    //[deprecated]
    shutdown: function()
    {
    log.debug("Shutting down sess...");
        if (this.reconnectTimer)
            this.reconnectTimer.cancel();
        if (this.certFailedReconnectTimer)
            this.certFailedReconnectTimer.cancel();
        if (this.onConnectDelayTimer)
            this.onConnectDelayTimer.cancel();
        this.disconnect();    
        

    },
    
    //[deprecated]
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBadCertListener2,
                                           Ci.nsIInterfaceRequestor,
                                           Ci.nsIStreamListener,
                                           Ci.nsITransportEventSink,
                                           Ci.nsIOutputStreamCallback])
};
