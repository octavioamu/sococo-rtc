/// <reference path="./types/MediaStream.d.ts"/>
/// <reference path="./types/RTCPeerConnection.d.ts"/>
/// <reference path="./Events.ts" />
/// <reference path="./LocalPeer.ts" />

module Sococo.RTC {
   declare var createIceServer:any;
   if(typeof createIceServer === 'undefined'){
      createIceServer = function(a,b,c){};
   }

   export var PCIceServers = {
      'iceServers': [
         createIceServer("stun:stun.l.google.com:19302"),
         createIceServer("stun:stun1.l.google.com:19302"),
         createIceServer("stun:stun2.l.google.com:19302"),
         createIceServer("stun:stun3.l.google.com:19302"),
         createIceServer("stun:stun4.l.google.com:19302")
      ]
   };

   export interface IPeerOffer {
      sdp:string;
      type:string;
   }

   export interface PeerConnectionConfig {
      pipe:any; // Faye.Client
      zoneId:string;  // Unique ID for zone
      localId:string; // Unique ID for local peer
      remoteId:string;// Unique ID for remote peer
   }

   export interface IGlareMessage {

      // The glare value for the generated message.
      glare:number;

      // The type of message to send.
      type:string;

      // The type of response message to glare check.
      ackType:string;

      // The callback to invoke when this message has been processed.
      //
      // `okay` If the first callback parameter is `true`, it means
      // the message was acknowledged (or won the race). If `okay` is
      // false, peer encountered a signal glare condition, and lost
      // the race.  The message should be discarded because the other
      // peer has sent a message of the same type that should take
      // precedence.
      callback:(okay:boolean,retry:boolean) => any;
   }


   /**
    * A connection between the current user and a peer.  Allows p2p offer/answer
    * and negotiation of media streams between two users.
    */
   export class PeerConnection extends Events {
      connection:RTCPeerConnection = null;
      config:PeerConnectionConfig;
      pipe:any; // TODO: Faye.Client?
      localStream:LocalMediaStream;
      remoteStream:MediaStream;

      // Default config is to only receive audio.
      properties:PeerProperties = null;

      constraints:any = {
         mandatory: {
            OfferToReceiveAudio: false,
            OfferToReceiveVideo: false
         },
         // Firefox requires DTLS, so add support for it when needed.
         optional: [{DtlsSrtpKeyAgreement: true }]
      };

      private _glareValue:number = -1;

      // Store a queue of ice candidates for processing.
      // This is because candidates may not be added before setRemoteDescription
      // has been called.  This usually works out as the offer will arrive before
      // any candidates, and it will call setRemoteDescription, but sometimes it
      // does not.   We can't guarantee that whatever signaling system you use
      // will provide messages in the order sent, so we enforce delayed processing
      // of candidates until after setRemoteDescription is called.
      private _iceCandidateQueue:any[] = [];

      private _heartbeatInterval:number;

      constructor(config:PeerConnectionConfig,props:PeerProperties){
         super();
         this.config = config;
         this.properties = props;
         this.pipe = this.config.pipe;
         var peerChannel = this.getPeerChannel();
         //console.warn("Subscribing to peer: \n",peerChannel);
         var sub = this.pipe.subscribe(peerChannel, (data) => {
            // Only process remote peer messages.
            if(data.userId !== this.config.localId){
               this._handlePeerMessage(data);
            }
         });
         sub.callback(() => {
            //console.warn("Subscribed to peer channel: \n",peerChannel);

            // Send a heartbeat so that our server doesn't think we've gone
            // away.  Looking at you, Heroku.  Probably other servers too.
            this._heartbeatInterval = setInterval(() => {
               this.send({heartbeat:true});
            },5000);

            this.createConnection();
            this.trigger('ready');
         });
         sub.errback(() => {
            console.error("failed to subscribe to",peerChannel);
         });
      }


      // Re/initialize the RTCPeerConnection between `config.localId` and `config.remoteId` peers.
      createConnection(){
         console.warn("----------------------- New RTCPeerConnection");
         this.destroyConnection();
         this.connection = new RTCPeerConnection(PCIceServers,this.constraints);
         this.connection.onaddstream = (event) => {
            this.onAddStream(event);
         };
         this.connection.onicecandidate = (event) => {
            this.onIceCandidate(event);
         };
         this.connection.onremovestream = (event) => {
            this.onRemoveStream(event);
         };
      }
      destroyConnection(){
         if(this.connection){
            this.connection.close();
            this.connection = null;
         }
         if(this.remoteStream){
            this.trigger('removeStream',this.remoteStream);
         }
         this.trigger('updateStream',this.localStream);
         this.remoteStream = this.connection = null;
         this._glareValue = -1;
      }

      // Signal glare handling.
      isOffering():boolean {
         return this._glareValue != -1;
      }


      send(data:any){
         data = data || {};
         data.userId = this.config.localId;
         this.pipe.publish(this.getPeerChannel(),data);
      }

      setLocalStream(stream:LocalMediaStream) {
         if(stream == this.localStream){
            return;
         }
         var oldStream:LocalMediaStream = this.localStream;
         this.localStream = stream;
         if(this.connection){
            if(oldStream){
               this.connection.removeStream(oldStream);
            }
            if(this.localStream){
               this.connection.addStream(stream);
            }
         }
      }
      // Properties changed, create a new PeerConnection/Offer with the desired properties.
      // The Peer should answer with their given properties.
      negotiateProperties(props:PeerProperties){
         console.warn("---> : Negotiate connection.");
         if(typeof props.sendAudio !== 'undefined'){
            this.properties.sendAudio = props.sendAudio;
         }
         if(typeof props.sendVideo !== 'undefined'){
            this.properties.sendVideo = props.sendVideo;
         }
         if(typeof props.receiveAudio !== 'undefined'){
            this.properties.receiveAudio = props.receiveAudio;
         }
         if(typeof props.receiveVideo !== 'undefined'){
            this.properties.receiveVideo = props.receiveVideo;
         }
         this._negotiateRequest();
      }

      answerWithProperties(offer:IPeerOffer,done?:(error?) => void){
         var msg:string = "---> : Answering peer offer";
         if(!this.connection){
            this.createConnection();
         }
         if(this.localStream && this.connection){
            this.connection.addStream(this.localStream);
            msg += " (broadcast)";
         }
         console.warn(msg);
         this.describeRemote(offer,(err?) => {
            if(!err){
               this.answer(offer,done);
            }
            else{
               console.error(err);
               done && done(err);
            }
         });
      }

      getPeerChannel():string {
         var inputs = [
            this.config.zoneId,
            this.config.localId,
            this.config.remoteId
         ];
         return '/' + inputs.sort().join('/');
      }

      destroy() {
         if(this.connection){
            this.pipe && this.send({type:'close'});
            this.connection.close();
            this.connection = null;
            if(this.remoteStream){
               this.trigger('removeStream',this.remoteStream);
               this.remoteStream = null;
            }
         }
      }

      updateConstraints() {
         this.constraints.mandatory.OfferToReceiveAudio = this.properties.receiveAudio === true;
         this.constraints.mandatory.OfferToReceiveVideo = this.properties.receiveVideo === true;
      }

      onIceCandidate(evt){
         var candidate = evt.candidate;
         if(candidate && this.isOffering()){
            this.send({
               type:'ice',
               glare:this._glareValue,
               candidate: JSON.stringify(candidate)
            });
         }
      }

      onAddStream(evt) {
         // TODO: Support multiple streams across one Peer.
         // Need to track the streams here, and be sure to clean them
         // up on destruction.
         console.warn('--- Add Remote Stream');
         this.remoteStream = evt.stream;
         this.trigger('addStream',evt.stream);
      }
      onRemoveStream(evt) {
         console.warn('--- Remove Remote Stream');
         this.trigger('removeStream',evt.stream);
         this.remoteStream = null;
      }

      offer(done?:(error?:any,offer?:any) => void, peerId:string=null){
         if(this.isOffering()){
            console.error("Tried to send multiple peer offers at the same time.");
            return;
         }
         this._glareValue = this._rollGlareValue();
         var peerChannel = this.getPeerChannel();
         var self = this;
         var offerCreated = (offer) => {
            this.connection.setLocalDescription(offer,() => {
               this._sendGlareMessage('offer','answer',{
                  type:'offer',
                  glare:this._glareValue,
                  offer: JSON.stringify(offer)
               },(okay:boolean,retry:boolean) => {
                  if(retry === true){
                     this._negotiateRequest();
                  }
                  done && done(null,offer);
               });
            },offerError);
         };
         var offerError = (error) => {
            console.warn("ERROR creating OFFER",error);
            done && done(error);
         };
         this.updateConstraints();
         this.connection.createOffer(offerCreated,offerError,this.constraints);
      }

      answer(offer:any, done?:(error?:any,offer?:any) => void){
         var answerCreated = (answer) => {
            this.connection.setLocalDescription(answer,() => {
               this.send({
                  type:'answer',
                  answer: JSON.stringify(answer)
               });
               done && done(null,answer);
            },answerError);
         };
         var answerError = (error) => {
            done && done(error);
         };
         this.updateConstraints();
         this.connection.createAnswer(answerCreated,answerError,this.constraints);
      }

      describeLocal(offer, done?:(error?) => void) {
         var descCreated = () => { done && done(); };
         var descError = (error) => { done && done(error); };
         this.connection.setLocalDescription(new RTCSessionDescription(offer),descCreated,descError);
      }
      describeRemote(offer, done?:(error?) => void) {
         var descCreated = () => { done && done(); };
         var descError = (error) => { done && done(error); };
         this.connection.setRemoteDescription(new RTCSessionDescription(offer),descCreated,descError);
      }

      //-----------------------------------------------------------------------
      // PeerConnection Renegotiation
      //-----------------------------------------------------------------------

      _negotiateRequest(){
         console.warn("---> : Send (re)negotiation request");
         this._sendGlareMessage('negotiate','negotiate-ack',null,(okay:boolean,retry:boolean) => {
            if(okay === true){
               this._negotiateGo();
            }
            else if(retry === true){
               this._negotiateRequest();
            }
         });
      }

      _negotiateAcknowledge(){
         console.warn("---> : Send (re)negotiation acknowledgement");
         this.send({
            type:'negotiate-ack'
         });
         this.createConnection();
      }

      _negotiateGo(data?:any){
         this.createConnection();
         if(this.localStream){
            this.connection.addStream(this.localStream);
         }
         this.offer((error?:any,offer?:any) => {
            if(error) {
               console.error(error);
            }
         });
      }


      //-----------------------------------------------------------------------
      // Signal Glare resistant messaging
      //-----------------------------------------------------------------------
      private _glareQueue:IGlareMessage[] = [];

      /**
       * Generate a pseudo-random glare value between min and max.
       * @returns {number} The generate glare value
       * @private
       */
      private _rollGlareValue():number {
         var min:number = 0;
         var max:number = 2048;
         return Math.floor(Math.random() * (max - min + 1)) + min;
      }

      private _sendGlareMessage(type:string,ackType:string,data:any,done?:(okay:boolean,retry:boolean) => any){
         // Don't allow duplicates based on message type.
         for(var i:number = 0; i < this._glareQueue.length; i++){
            if(this._glareQueue[i].type === type){
               console.error("Attempted to send glare message while waiting for a glare ack of the same type");
               return;
            }
         }

         // Generate a glare value.
         var glareRoll:number = this._rollGlareValue();

         // Note: we index by ackType because we compare/discard/accept on receipt of the response.
         this._glareQueue.push({
            glare:glareRoll,
            type:type,
            ackType:ackType,
            callback:done
         });

         console.warn("Send Glare Message (" + type + ") = " + glareRoll);
         // Fire off the message.
         this.send({
            type:type,
            data:data,
            glare:glareRoll
         });
      }

      /**
       * Handle a message with a glare value attached to it.
       * @param data The message to handle.
       * @returns {Object|null}
       * @private
       */
      private _handleGlareMessage(data:any):boolean{
         var pending:IGlareMessage = null;
         var index:number = -1;
         for(var i:number = 0; i < this._glareQueue.length; i++){
            if(this._glareQueue[i].ackType === data.type || this._glareQueue[i].type === data.type){
               index = i;
               pending = this._glareQueue[i];
               break;
            }
         }

         // If there is no pending glare ack for this type, or the type contains
         // no glare information, return and let the default message handler take
         // care of things.
         if(index === -1 || !pending || typeof data.glare === 'undefined'){
            return data;
         }

         // Received a response to the glare message type, safe to continue
         // processing.
         if(data.type === pending.ackType){
            pending.callback(true,false);
         }
         // Received a conflicting message, need to compare glare values:
         //
         // If the glare values are equal, both sides generate new glare values and
         // try again.
         else if(data.glare === pending.glare){
            console.warn("       DISCARDED " + pending.type + ": glare values matched.  Retry.");
            pending.callback(false,true);
         }
         // If the remote message has a
         else if(data.glare > pending.glare){
            console.warn("       DISCARD LOCAL " + pending.type + ": " + data.glare  + " > " + pending.glare);
            pending.callback(false,false);
         }
         else if(data.glare < pending.glare){
            console.warn("       DISCARD REMOTE " + pending.type + ": " + data.glare  + " < " + pending.glare);
            pending.callback(true,false);
         }

         // Remove the glare message now that we're done with it.
         this._glareQueue.splice(index);
         return null;
      }


      //-----------------------------------------------------------------------
      // Ice Candidate Processing
      //  - Handle race conditions with offer by queuing ice candidates
      //    until setRemoteDescription is called.
      //-----------------------------------------------------------------------
      private _processIceQueue(){
         var queue = this._iceCandidateQueue;
         for(var i:number = 0; i < queue.length; i++){
            var msg = queue[i];
            this._handleIceCandidate(msg);
         }
         this._iceCandidateQueue = [];
      }

      private _handleIceCandidate(data:any){
         var candidate = JSON.parse(data.candidate);
         if(candidate && data.glare === this._glareValue){
            try{
               this.connection.addIceCandidate(new RTCIceCandidate(candidate));
               return true;
            }
            catch(e){
               console.error("Failed candidate --- " + candidate, e);
            }
         }
         return false;
      }

      //-----------------------------------------------------------------------
      // Messaging
      //-----------------------------------------------------------------------
      private _handlePeerMessage(data:any){
         // Ignore glare rejects.
         data = this._handleGlareMessage(data);
         if(data === null){
            return;
         }
         switch(data.type){
            case "offer":
               data = data.data;
               var offer = JSON.parse(<any>data.offer);
               console.warn("<--- : Receive peer offer");
               this.answerWithProperties(offer,(err?) => {
                  if(typeof err === 'undefined'){
                     this._glareValue = data.glare;
                     this._processIceQueue();
                  }
               });
               break;
            case "answer":
               var answer = JSON.parse(data.answer);
               console.warn("<--- : Receive peer answer");
               this.describeRemote(answer,(err?) => {
                  if(err){
                     console.error(err);
                  }
               });
               break;
            case "ice":
               if(!this._handleIceCandidate(data)){
                  this._iceCandidateQueue.push(data);
               }
               break;
            case "negotiate":
               data = data.data;
               console.warn("<--- : Receive peer (re)negotiation request");
               // Peer wants to negotiate a new connection.  acknowledge the request, replace
               // any existing RTCPeerConnection, and wait for a new offer.
               this._negotiateAcknowledge();
               break;
            case "negotiate-ack":
               console.warn("<--- : Receive peer (re)negotiation acknowledgment");
               // Peer is waiting for a new offer in response to a 'negotiate' request.  Create
               // a new RTCPeerConnection, and send an offer to the user.
               this._negotiateGo(data);
               break;
            case "close":
               if(this.remoteStream){
                  this.trigger("removeStream",this.remoteStream);
                  this.remoteStream = null;
               }
               break;
         }
      }

   }
}