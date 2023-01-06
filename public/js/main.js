/* eslint-env jquery, browser */
$(document).ready(() => {
  // Place JavaScript code here...
  $('#res').ready(function(){
    // Get each div
    $('span').each(function(){
        // Get the content
        var str = $(this).html();
        // Set the regex string
        var regex = /(https?:\/\/([-\w\.]+)+(:\d+)?(\/([\w\/_\.]*(\?\S+)?)?)?)/ig
        // Replace plain text links by hyperlinks
        var replaced_text = str.replace(regex, "<a href='$1' target='_blank'>$1</a>");
        // Echo link
        $(this).html(replaced_text);
    });

    $('form').submit(function() {
      $("#luck").text("Doing some GPT magic...");
      $("#luck").attr("disabled", true);
    });
});
});
